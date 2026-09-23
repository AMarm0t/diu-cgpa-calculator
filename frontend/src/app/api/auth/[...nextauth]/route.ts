import NextAuth from "next-auth";
import GoogleProvider from "next-auth/providers/google";

const handler = NextAuth({
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID || process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
      authorization: {
        params: {
          prompt: "select_account",
          access_type: "online",
          scope: "openid email profile",
        },
      },
    }),
  ],
  callbacks: {
    async jwt({ token, account }) {
      // On initial sign-in, persist the Google access_token into the JWT
      if (account) {
        token.accessToken = account.access_token;
        token.idToken = account.id_token;
      }
      return token;
    },
    async session({ session, token }) {
      // Expose the Google access_token to the client via session
      (session as any).accessToken = token.accessToken;
      (session as any).idToken = token.idToken;
      return session;
    },
  },
  pages: {
    signIn: "/admin", // Redirect back to admin page on sign-in
  },
  secret: process.env.NEXTAUTH_SECRET,
});

export { handler as GET, handler as POST };
