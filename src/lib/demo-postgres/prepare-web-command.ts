import { preparePostgresWebDatabase } from './prepare-web';
void preparePostgresWebDatabase(process.env.MRP_DEMO_POSTGRES_URL).catch(error => { console.error(error instanceof Error ? error.message.replace(/postgres(?:ql)?:\/\/[^\s'"]+/g, '[synthetic demo target]') : 'PostgreSQL Demo setup failed'); process.exitCode = 1; });
