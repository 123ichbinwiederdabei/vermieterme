import NextAuth from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import Credentials from "next-auth/providers/credentials";
import Apple from "next-auth/providers/apple";
import { hashPassword, verifyPassword } from "./password";
import { prisma } from "./prisma";
import { authConfig } from "./auth.config";

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  adapter: PrismaAdapter(prisma),
  providers: [
    ...(process.env.AUTH_APPLE_ID
      ? [
          Apple({
            clientId: process.env.AUTH_APPLE_ID,
            clientSecret: process.env.AUTH_APPLE_SECRET!,
          }),
        ]
      : []),
    Credentials({
      name: "Anmeldedaten",
      credentials: {
        email: { label: "E-Mail", type: "email" },
        password: { label: "Passwort", type: "password" },
      },
      async authorize(credentials) {
        const email = credentials.email as string;
        const password = credentials.password as string;

        if (!email || !password) return null;

        // Check against env vars for simple self-hosted admin auth
        if (
          email === process.env.ADMIN_EMAIL &&
          password === process.env.ADMIN_PASSWORD
        ) {
          let user = await prisma.user.findUnique({ where: { email } });
          if (!user) {
            user = await prisma.user.create({
              data: {
                email,
                name: "Admin",
                password: await hashPassword(password),
              },
            });
          }
          return user;
        }

        // Check database users with hashed password
        const user = await prisma.user.findUnique({ where: { email } });

        if (!user || !user.password) {
          return null;
        }

        const passwordValid = await verifyPassword(password, user.password);
        if (!passwordValid) {
          return null;
        }

        return user;
      },
    }),
  ],
});
