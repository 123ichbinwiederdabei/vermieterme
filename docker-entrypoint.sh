#!/bin/sh
set -e

echo "Running versioned database migrations..."
node node_modules/prisma/build/index.js migrate deploy --schema=./prisma/schema.prisma
echo "Database ready."

if [ "${INVOICE_WORKER_MODE:-0}" = "1" ]; then
  exec node dist/invoice-worker.cjs
fi
exec node server.js
