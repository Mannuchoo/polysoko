import fs from 'fs';
import path from 'path';
import SftpClient from 'ssh2-sftp-client';

function parseEnvFile(filePath) {
  const result = {};
  if (!fs.existsSync(filePath)) return result;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.trim().startsWith('#')) continue;
    const [key, ...rest] = line.split('=');
    if (!key || rest.length === 0) continue;
    result[key.trim()] = rest.join('=').trim();
  }
  return result;
}

const rootEnv = path.join(process.cwd(), '.env');
const fallbackEnv = path.join(process.cwd(), 'server', '.env');
const env = Object.assign({}, parseEnvFile(rootEnv), parseEnvFile(fallbackEnv));

const required = ['SFTP_HOST', 'SFTP_PORT', 'SFTP_USER', 'SFTP_PASSWORD', 'SFTP_REMOTE_PATH'];
const missing = required.filter((key) => !env[key]);
if (missing.length) {
  console.error('Missing required environment variables:', missing.join(', '));
  process.exit(1);
}

const buildDir = path.join(process.cwd(), 'dist');
if (!fs.existsSync(buildDir)) {
  console.error('Build directory not found. Run npm run build first.');
  process.exit(1);
}

const remotePath = env.SFTP_REMOTE_PATH.replace(/\/+$/, '');
const sftp = new SftpClient();

async function deploy() {
  try {
    await sftp.connect({
      host: env.SFTP_HOST,
      port: Number(env.SFTP_PORT) || 22,
      username: env.SFTP_USER,
      password: env.SFTP_PASSWORD,
    });

    console.log(`Connected to ${env.SFTP_HOST}:${env.SFTP_PORT}`);
    // Removed the mkdir line to prevent permission errors on existing public_html
    await sftp.uploadDir(buildDir, remotePath);
    console.log(`Uploaded ${buildDir} to ${env.SFTP_HOST}:${remotePath}`);
  } catch (err) {
    console.error('SFTP deployment failed:', err.message || err);
    process.exit(1);
  } finally {
    await sftp.end();
  }
}

deploy();