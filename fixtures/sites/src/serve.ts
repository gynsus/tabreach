import { startFixtureServer } from './server.ts';

const server = await startFixtureServer();
console.log(`Fixture sites: ${server.url}`);
