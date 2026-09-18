import { createServer, type ViteDevServer } from "vite";

const defaultPort = 5173;

async function isReachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export default async function startPlaywrightServer(): Promise<
  () => Promise<void>
> {
  if (process.env.PLAYWRIGHT_EXTERNAL_SERVER === "1") {
    return () => Promise.resolve();
  }
  const requestedPort = Number.parseInt(
    process.env.PLAYWRIGHT_PORT ?? String(defaultPort),
    10,
  );
  const port =
    Number.isSafeInteger(requestedPort) &&
    requestedPort > 0 &&
    requestedPort <= 65_535
      ? requestedPort
      : defaultPort;
  const url = `http://127.0.0.1:${port}`;

  if (await isReachable(url)) {
    return () => Promise.resolve();
  }

  let server: ViteDevServer | undefined;
  try {
    server = await createServer({
      root: "apps/desktop",
      clearScreen: false,
      logLevel: "warn",
      server: {
        host: "127.0.0.1",
        port,
        strictPort: true,
      },
    });
    await server.listen();
  } catch (error) {
    await server?.close();
    throw error;
  }

  return async () => {
    await server?.close();
  };
}
