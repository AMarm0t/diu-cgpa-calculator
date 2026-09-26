import NextAuth from "next-auth";
import type { JWT } from "next-auth/jwt";
import GoogleProvider from "next-auth/providers/google";

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";

// Google's ID/access tokens expire after 1 hour while the NextAuth session lasts 30 days, so the
// admin panel kept sending an expired token and the backend (correctly) answered "Access denied".
// The session now keeps Google's refresh token (inside the encrypted session cookie, never exposed
// to the page) and renews the tokens shortly before they expire.
const RENEW_BEFORE_EXPIRY_SECONDS = 10 * 60;

async function renewGoogleTokens(token: JWT): Promise<JWT> {
  if (!token.refreshToken) return { ...token, error: "RefreshTokenMissing" };
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: String(token.refreshToken),
      }),
    });
    const data = await res.json();
    if (!res.ok) return { ...token, error: "RefreshFailed" };
    return {
      ...token,
      idToken: data.id_token ?? token.idToken,
      accessToken: data.access_token ?? token.accessToken,
      expiresAt: Math.floor(Date.now() / 1000) + Number(data.expires_in ?? 3600),
      refreshToken: data.refresh_token ?? token.refreshToken, // Google usually keeps the same one
      error: undefined,
    };
  } catch {
    return { ...token, error: "RefreshFailed" };
  }
}

const handler = NextAuth({
  providers: [
    GoogleProvider({
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      authorization: {
        params: {
          // "consent" makes Google return a refresh token on every sign-in (it is only sent with
          // consent); "offline" is what grants one.
          prompt: "consent select_account",
          access_type: "offline",
          scope: "openid email profile",
        },
      },
    }),
  ],
  callbacks: {
    async jwt({ token, account }) {
      if (account) {
        // Initial sign-in: keep Google's tokens and when they expire
        return {
          ...token,
          idToken: account.id_token,
          accessToken: account.access_token,
          refreshToken: account.refresh_token ?? token.refreshToken,
          expiresAt: account.expires_at ?? Math.floor(Date.now() / 1000) + 3600,
          error: undefined,
        };
      }
      const expiresAt = Number(token.expiresAt ?? 0);
      if (Date.now() / 1000 < expiresAt - RENEW_BEFORE_EXPIRY_SECONDS) return token;
      return renewGoogleTokens(token);
    },
    async session({ session, token }) {
      // Only what the admin panel needs; the refresh token stays server-side in the cookie
      (session as any).accessToken = token.accessToken;
      (session as any).idToken = token.idToken;
      (session as any).error = token.error;
      return session;
    },
  },
  pages: {
    signIn: "/admin", // Redirect back to admin page on sign-in
  },
  secret: process.env.NEXTAUTH_SECRET,
});

export { handler as GET, handler as POST };
