export function register(): void {
  if (process.env.NEXT_RUNTIME !== 'nodejs') {
    return;
  }

  const { registerDemoIsolation } =
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('./lib/demo/isolation') as typeof import('./lib/demo/isolation');
  registerDemoIsolation();
}
