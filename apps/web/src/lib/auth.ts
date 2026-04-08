/**
 * NextAuth Configuration
 */

import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@provacx/database";
import bcrypt from "bcryptjs";
import NextAuth from "next-auth";
import type { NextAuthConfig, NextAuthResult } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { z } from "zod";


const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const authDebug =
  process.env.NEXTAUTH_DEBUG === "true" ||
  process.env.AUTH_DEBUG === "true" ||
  process.env.NODE_ENV === "development";

const authSecret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;

const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
const googleEnabled = Boolean(googleClientId && googleClientSecret);

if (!authSecret) {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Missing auth secret. Set AUTH_SECRET (recommended) or NEXTAUTH_SECRET."
    );
  }

  if (authDebug) {
    console.warn(
      "Auth secret is missing. Set AUTH_SECRET (recommended) or NEXTAUTH_SECRET."
    );
  }
}

if (authDebug && !googleEnabled) {
  console.warn(
    "Google OAuth is disabled. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to enable it."
  );
}

export const authConfig: NextAuthConfig = {
  adapter: PrismaAdapter(prisma),
  debug: authDebug,
  trustHost: process.env.NODE_ENV === "development",
  secret: authSecret,
  session: {
    strategy: "jwt",
    maxAge: 30 * 24 * 60 * 60, // 30 days
  },
  pages: {
    signIn: "/login",
    signOut: "/",
    error: "/login",
    newUser: "/onboarding/organization",
  },
  providers: [
    ...(googleEnabled
      ? [
          Google({
            clientId: googleClientId!,
            clientSecret: googleClientSecret!,
            authorization: {
              params: {
                prompt: "select_account",
                access_type: "offline",
              },
            },
          }),
        ]
      : []),
    Credentials({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const parsed = credentialsSchema.safeParse(credentials);

        if (!parsed.success) {
          return null;
        }

        const { email, password } = parsed.data;

        const user = await prisma.user.findUnique({
          where: { email: email.toLowerCase() },
        });

        if (!user || !user.password) {
          return null;
        }

        const passwordMatch = await bcrypt.compare(password, user.password);

        if (!passwordMatch) {
          return null;
        }

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.image,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user, account, profile }) {
      // Initial sign in
      if (user) {
        token.id = user.id;
        token.email = user.email;
        token.name = user.name;
        token.image = user.image;
      }

      // Google OAuth - ensure we have the profile data
      if (account?.provider === "google" && profile) {
        token.email = profile.email;
        token.name = profile.name;
        token.image = profile.picture;

        // Look up the DB user created by PrismaAdapter so we have the correct id
        if (profile.email) {
          const dbUser = await prisma.user.findUnique({
            where: { email: profile.email as string },
            select: { id: true },
          });
          if (dbUser) {
            token.id = dbUser.id;
          }
        }
      }

      return token;
    },
    async session({ session, token }) {
      if (token && session.user) {
        session.user.id = token.id as string;
        session.user.email = token.email as string;
        session.user.name = (token.name as string) ?? null;
        session.user.image = (token.image as string) ?? null;
      }
      return session;
    },
  },
};

const nextAuth: NextAuthResult = NextAuth(authConfig);

export const handlers: NextAuthResult["handlers"] = nextAuth.handlers;
export const auth: NextAuthResult["auth"] = nextAuth.auth;
export const signIn: NextAuthResult["signIn"] = nextAuth.signIn;
export const signOut: NextAuthResult["signOut"] = nextAuth.signOut;

export const { GET, POST } = handlers;

/**
 * Get session on server side
 */
export async function getSession() {
  return auth();
}

/**
 * Require authentication
 * Throws redirect to login if not authenticated
 */
export async function requireAuth() {
  const session = await getSession();
  if (!session?.user) {
    throw new Error("Unauthorized");
  }
  return session;
}
