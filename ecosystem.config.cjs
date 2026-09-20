// pm2 processes for running Calendor directly on a server (the alternative to the Docker images).
// Deploy or update with `npm run deploy`: builds, runs migrations, then (re)starts both processes.
// Configuration comes from .env; the web server listens on 127.0.0.1 only, behind the reverse proxy.
module.exports = {
  apps: [
    {
      name: 'calendor-web',
      cwd: `${__dirname}/.next/standalone`,
      script: 'server.js',
      node_args: `--env-file=${__dirname}/.env`,
      env: { NODE_ENV: 'production', PORT: '9000', HOSTNAME: '127.0.0.1' },
      max_memory_restart: '1G',
    },
    {
      name: 'calendor-worker',
      cwd: __dirname,
      script: 'dist/worker.js',
      env: { NODE_ENV: 'production' },
      max_memory_restart: '1G',
    },
  ],
};
