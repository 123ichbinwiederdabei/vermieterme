#!/bin/sh
set -e

echo "Running versioned database migrations..."
node node_modules/prisma/build/index.js migrate deploy --schema=./prisma/schema.prisma
echo "Database ready."

exec node server.js
