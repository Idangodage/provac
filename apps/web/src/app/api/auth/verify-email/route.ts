import { prisma } from "@provacx/database";
import { NextResponse } from "next/server";
import { z } from "zod";

import { sha256 } from "@/lib/tokens";

const verifySchema = z.object({
  token: z.string().min(10),
  email: z.string().email().transform((v) => v.toLowerCase()),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const email = url.searchParams.get("email");

  const parsed = verifySchema.safeParse({ token, email });
  if (!parsed.success) {
    return NextResponse.redirect(new URL("/login?error=Verification", url));
  }

  const tokenHash = sha256(parsed.data.token);
  const record = await prisma.verificationToken.findUnique({
    where: { token: tokenHash },
  });

  const identifier = `verify:${parsed.data.email}`;
  if (
    !record ||
    record.identifier !== identifier ||
    record.expires < new Date()
  ) {
    return NextResponse.redirect(new URL("/login?error=Verification", url));
  }

  await prisma.$transaction([
    prisma.user.updateMany({
      where: { email: parsed.data.email },
      data: { emailVerified: new Date() },
    }),
    prisma.verificationToken.deleteMany({
      where: { identifier },
    }),
  ]);

  return NextResponse.redirect(new URL("/login?verified=1", url));
}
