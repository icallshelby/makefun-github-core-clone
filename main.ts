// main.ts — Lifecycle entrypoint (competition trial mode & standalone mode)

import { Store } from './store.ts';
import { createApp } from './app.ts';

const envUrl = process.env.MAKEFUN_ENV_URL;
const token = process.env.MAKEFUN_SHOP_TOKEN;
const portEnv = process.env.PORT;

if (!token) {
  console.error('Error: MAKEFUN_SHOP_TOKEN environment variable is required.');
  process.exit(1);
}

const store = new Store();
const server = createApp(store, token);

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function registerWithRetry(registerUrl: string, port: number, tokenStr: string): Promise<void> {
  let delay = 250;
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      const res = await fetch(registerUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${tokenStr}`,
        },
        body: JSON.stringify({ port }),
      });
      if (res.status === 200 || res.status === 409) {
        return;
      }
      if (res.status === 400 || res.status === 405) {
        console.error(`Fatal registration error status ${res.status}`);
        process.exit(1);
      }
    } catch {}
    await sleep(delay);
    delay = Math.min(delay * 2, 2000);
  }
  console.error('Registration failed after retries.');
  process.exit(1);
}

async function pollDone(doneUrl: string, tokenStr: string): Promise<void> {
  let delay = 250;
  while (true) {
    try {
      const res = await fetch(doneUrl, {
        headers: {
          'Authorization': `Bearer ${tokenStr}`,
        },
      });
      if (res.ok) {
        const data = (await res.json()) as { done?: boolean };
        if (data && data.done) {
          return;
        }
      }
    } catch {}
    await sleep(delay);
    delay = Math.min(delay * 2, 2000);
  }
}

server.listen(portEnv ? Number(portEnv) : 0, async () => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  if (envUrl) {
    console.log(`Competition trial mode listening on port ${port}`);
    const regUrl = `${envUrl.replace(/\/$/, '')}/register`;
    const doneUrl = `${envUrl.replace(/\/$/, '')}/done`;

    await registerWithRetry(regUrl, port, token);
    await pollDone(doneUrl, token);

    server.close(() => {
      process.exit(0);
    });
  } else if (portEnv) {
    console.log(`listening on port ${port}`);
  } else {
    console.error('Error: Neither MAKEFUN_ENV_URL nor PORT is set.');
    server.close();
    process.exit(1);
  }
});
