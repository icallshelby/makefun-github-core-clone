// main.ts — Enterprise-grade service entry point, lifecycle manager, and coordination daemon for make.fun core forge

import http from 'node:http';
import process from 'node:process';
import { Store } from './store.ts';
import { createApp } from './app.ts';

// --- Configuration & Environment Management ---

interface ServiceConfig {
  shopToken: string;
  coordinatorUrl?: string;
  port?: number;
  host: string;
  logLevel: 'error' | 'warn' | 'info' | 'debug';
  registerMaxAttempts: number;
  registerBaseDelayMs: number;
  registerMaxDelayMs: number;
  shutdownTimeoutMs: number;
}

const LOG_LEVELS: Record<string, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

class StructuredLogger {
  private minLevel: 'error' | 'warn' | 'info' | 'debug';
  private contextName: string;

  constructor(minLevel: 'error' | 'warn' | 'info' | 'debug', contextName = 'CoreForge') {
    this.minLevel = minLevel;
    this.contextName = contextName;
  }

  private shouldLog(level: 'error' | 'warn' | 'info' | 'debug'): boolean {
    return LOG_LEVELS[level] <= LOG_LEVELS[this.minLevel];
  }

  private write(level: string, msg: string, meta?: Record<string, unknown>) {
    if (!this.shouldLog(level as any)) return;
    const timestamp = new Date().toISOString();
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
    console.log(`[${timestamp}] [${level.toUpperCase()}] [${this.contextName}] ${msg}${metaStr}`);
  }

  error(msg: string, meta?: Record<string, unknown>) { this.write('error', msg, meta); }
  warn(msg: string, meta?: Record<string, unknown>) { this.write('warn', msg, meta); }
  info(msg: string, meta?: Record<string, unknown>) { this.write('info', msg, meta); }
  debug(msg: string, meta?: Record<string, unknown>) { this.write('debug', msg, meta); }
}

function parseIntegerEnv(val: string | undefined, defaultVal: number, logger: StructuredLogger, name: string): number {
  if (val === undefined || val === '') return defaultVal;
  const parsed = Number(val);
  if (Number.isNaN(parsed)) {
    logger.warn(`Invalid numeric environment variable ${name}='${val}', falling back to default ${defaultVal}`);
    return defaultVal;
  }
  return parsed;
}

function loadConfiguration(logger: StructuredLogger): ServiceConfig {
  const shopToken = process.env.MAKEFUN_SHOP_TOKEN;
  if (!shopToken || shopToken.trim() === '') {
    logger.error('CRITICAL: MAKEFUN_SHOP_TOKEN environment variable is required but missing.');
    console.error('Error: MAKEFUN_SHOP_TOKEN is required');
    process.exit(1);
  }

  const coordinatorUrl = process.env.MAKEFUN_ENV_URL ? process.env.MAKEFUN_ENV_URL.replace(/\/+$/, '') : undefined;
  const rawPort = process.env.PORT;
  const port = rawPort !== undefined && rawPort !== '' ? parseIntegerEnv(rawPort, 0, logger, 'PORT') : undefined;
  const host = process.env.HOST || '127.0.0.1';

  const rawLogLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();
  const logLevel = (['error', 'warn', 'info', 'debug'].includes(rawLogLevel) ? rawLogLevel : 'info') as any;

  const registerMaxAttempts = parseIntegerEnv(process.env.REGISTER_MAX_ATTEMPTS, 10, logger, 'REGISTER_MAX_ATTEMPTS');
  const registerBaseDelayMs = parseIntegerEnv(process.env.REGISTER_BASE_DELAY_MS, 250, logger, 'REGISTER_BASE_DELAY_MS');
  const registerMaxDelayMs = parseIntegerEnv(process.env.REGISTER_MAX_DELAY_MS, 2000, logger, 'REGISTER_MAX_DELAY_MS');
  const shutdownTimeoutMs = parseIntegerEnv(process.env.SHUTDOWN_TIMEOUT_MS, 5000, logger, 'SHUTDOWN_TIMEOUT_MS');

  return {
    shopToken,
    coordinatorUrl,
    port,
    host,
    logLevel,
    registerMaxAttempts,
    registerBaseDelayMs,
    registerMaxDelayMs,
    shutdownTimeoutMs,
  };
}

// --- Utilities: Sleep & Exponential Backoff ---

async function asyncSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function computeBackoffDelay(attempt: number, baseDelay: number, maxDelay: number): number {
  const exponential = baseDelay * Math.pow(2, attempt - 1);
  const capped = Math.min(exponential, maxDelay);
  const jitter = Math.random() * 50;
  return Math.floor(capped + jitter);
}

// --- Trial Mode Coordinator Operations ---

async function registerWithCoordinator(
  coordinatorUrl: string,
  token: string,
  port: number,
  maxAttempts: number,
  baseDelay: number,
  maxDelay: number,
  logger: StructuredLogger
): Promise<boolean> {
  const endpoint = `${coordinatorUrl}/register`;
  const payload = JSON.stringify({ port });

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    logger.info(`Attempting registration with coordinator (attempt ${attempt}/${maxAttempts})`, { endpoint, port });
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: payload,
      });

      if (response.status === 200 || response.status === 201) {
        logger.info(`Successfully registered with coordinator on attempt ${attempt}`, { status: response.status });
        return true;
      }

      if (response.status === 400 || response.status === 401) {
        logger.error(`Fatal registration error received from coordinator: HTTP ${response.status}`, { status: response.status });
        return false;
      }

      logger.warn(`Registration returned non-success status HTTP ${response.status}`, { status: response.status });
    } catch (err: any) {
      logger.warn(`Network error during registration attempt ${attempt}: ${err.message}`, { error: err.message });
    }

    if (attempt < maxAttempts) {
      const delay = computeBackoffDelay(attempt, baseDelay, maxDelay);
      logger.debug(`Waiting ${delay}ms before next registration attempt`);
      await asyncSleep(delay);
    }
  }

  logger.error(`Exhausted all ${maxAttempts} registration attempts without success.`);
  return false;
}

async function pollCoordinatorCompletion(
  coordinatorUrl: string,
  token: string,
  baseDelay: number,
  maxDelay: number,
  logger: StructuredLogger
): Promise<void> {
  const endpoint = `${coordinatorUrl}/done`;
  logger.info('Starting polling loop for completion indicator (/done)', { endpoint });

  let pollCount = 0;
  while (true) {
    pollCount++;
    try {
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      if (response.ok) {
        const data = (await response.json()) as { done?: boolean };
        logger.debug(`Poll ${pollCount} response received`, { status: response.status, data });
        if (data && data.done) {
          logger.info('Coordinator signaled completion (done: true). Initiating graceful shutdown.');
          return;
        }
      } else {
        logger.debug(`Poll ${pollCount} returned non-OK status: ${response.status}`);
      }
    } catch (err: any) {
      logger.debug(`Poll ${pollCount} encountered network error: ${err.message}`);
    }

    const delay = computeBackoffDelay(pollCount % 10 + 1, baseDelay, maxDelay);
    await asyncSleep(delay);
  }
}

// --- Readiness Self-Check ---

async function performReadinessCheck(port: number, token: string, host: string, logger: StructuredLogger): Promise<void> {
  const url = `http://${host}:${port}/healthz`;
  logger.info('Performing local readiness self-check on server', { url });
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });
    if (res.ok) {
      logger.info('Readiness self-check passed successfully', { status: res.status });
    } else {
      logger.warn(`Readiness self-check returned unexpected status HTTP ${res.status}`, { status: res.status });
    }
  } catch (err: any) {
    logger.warn(`Readiness self-check network connection failed: ${err.message}`, { error: err.message });
  }
}

// --- Main Application Lifecycle Coordinator ---

async function bootstrap() {
  const logger = new StructuredLogger('info', 'MainBootstrap');
  const config = loadConfiguration(logger);

  logger.info('Initializing make.fun core forge service components', {
    nodeVersion: process.version,
    pid: process.pid,
    hasCoordinator: !!config.coordinatorUrl,
    targetPort: config.port ?? 'ephemeral',
  });

  const store = new Store();
  const appServer = createApp(store, config.shopToken);

  // Track open sockets for graceful shutdown
  const activeSockets = new Set<http.Socket>();
  appServer.on('connection', (socket: http.Socket) => {
    activeSockets.add(socket);
    socket.on('close', () => {
      activeSockets.delete(socket);
    });
  });

  let assignedPort = config.port ?? 0;

  await new Promise<void>((resolve, reject) => {
    appServer.on('error', (err: any) => {
      logger.error(`Server listen failure: ${err.message}`, { code: err.code });
      reject(err);
    });

    appServer.listen(assignedPort, config.host, () => {
      const addressInfo = appServer.address();
      if (addressInfo && typeof addressInfo === 'object') {
        assignedPort = addressInfo.port;
      }
      logger.info(`Server successfully bound and listening`, { host: config.host, port: assignedPort });
      resolve();
    });
  });

  // Perform self check
  await performReadinessCheck(assignedPort, config.shopToken, config.host, logger);

  let exitCode = 0;

  if (config.coordinatorUrl) {
    logger.info('Running in TRIAL MODE: registering with coordinator and polling /done');
    const registered = await registerWithCoordinator(
      config.coordinatorUrl,
      config.shopToken,
      assignedPort,
      config.registerMaxAttempts,
      config.registerBaseDelayMs,
      config.registerMaxDelayMs,
      logger
    );

    if (!registered) {
      logger.error('Trial mode registration failed definitively. Exiting with error code 1.');
      exitCode = 1;
    } else {
      await pollCoordinatorCompletion(
        config.coordinatorUrl,
        config.shopToken,
        config.registerBaseDelayMs,
        config.registerMaxDelayMs,
        logger
      );
      exitCode = 0;
    }
  } else if (config.port !== undefined) {
    logger.info('Running in STANDALONE MODE with explicit PORT. Serving indefinitely.');
    await new Promise<void>(() => {});
  } else {
    logger.error('Error: Neither MAKEFUN_ENV_URL nor PORT was specified.');
    console.error('Error: Either MAKEFUN_ENV_URL or PORT environment variable must be set.');
    exitCode = 1;
  }

  // Graceful Shutdown Procedure
  logger.info('Initiating graceful shutdown sequence', { exitCode, activeSocketsCount: activeSockets.size });
  
  await new Promise<void>((resolve) => {
    appServer.close(() => {
      logger.info('HTTP server stopped accepting new connections.');
      resolve();
    });

    const timer = setTimeout(() => {
      logger.warn(`Shutdown timeout (${config.shutdownTimeoutMs}ms) reached. Force destroying ${activeSockets.size} open sockets.`);
      for (const socket of activeSockets) {
        socket.destroy();
      }
    }, config.shutdownTimeoutMs);

    timer.unref();
  });

  logger.info('Graceful shutdown completed successfully. Exiting process.', { exitCode });
  process.exit(exitCode);
}

// Global Exception Handlers
process.on('uncaughtException', (err: Error) => {
  console.error('[CRITICAL] Uncaught exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  console.error('[CRITICAL] Unhandled promise rejection:', reason);
  process.exit(1);
});

// Signal handling
let shutdownSignalsReceived = 0;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    shutdownSignalsReceived++;
    console.warn(`[WARNING] Received signal ${sig} (count: ${shutdownSignalsReceived})`);
    if (shutdownSignalsReceived >= 2) {
      console.error('[ERROR] Second shutdown signal received. Forcing immediate exit.');
      process.exit(1);
    }
    process.exit(0);
  });
}

bootstrap().catch((err) => {
  console.error('[FATAL] Bootstrap failure:', err);
  process.exit(1);
});
