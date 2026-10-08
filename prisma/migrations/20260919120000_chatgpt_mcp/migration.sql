-- CreateTable
CREATE TABLE "McpOAuthClient" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT,
    "redirectUrisJson" TEXT NOT NULL,
    "tokenEndpointAuthMethod" TEXT NOT NULL DEFAULT 'none',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "McpAuthorizationCode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "codeHash" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "scopesJson" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "codeChallenge" TEXT NOT NULL,
    "codeChallengeMethod" TEXT NOT NULL DEFAULT 'S256',
    "expiresAt" DATETIME NOT NULL,
    "consumedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "McpAuthorizationCode_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "McpOAuthClient" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "McpRefreshToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tokenHash" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scopesJson" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "revokedAt" DATETIME,
    "replacedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "McpRefreshToken_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "McpOAuthClient" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "McpMutationTokenUse" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "itemRef" TEXT NOT NULL,
    "usedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "McpAuditEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "itemRef" TEXT,
    "reason" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "beforeJson" TEXT,
    "afterJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "McpAuditEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "McpAuthorizationCode_codeHash_key" ON "McpAuthorizationCode"("codeHash");
CREATE INDEX "McpAuthorizationCode_clientId_expiresAt_idx" ON "McpAuthorizationCode"("clientId", "expiresAt");
CREATE UNIQUE INDEX "McpRefreshToken_tokenHash_key" ON "McpRefreshToken"("tokenHash");
CREATE INDEX "McpRefreshToken_clientId_userId_idx" ON "McpRefreshToken"("clientId", "userId");
CREATE INDEX "McpRefreshToken_expiresAt_idx" ON "McpRefreshToken"("expiresAt");
CREATE INDEX "McpMutationTokenUse_userId_usedAt_idx" ON "McpMutationTokenUse"("userId", "usedAt");
CREATE INDEX "McpAuditEvent_userId_createdAt_idx" ON "McpAuditEvent"("userId", "createdAt");
CREATE INDEX "McpAuditEvent_entityType_itemRef_idx" ON "McpAuditEvent"("entityType", "itemRef");
