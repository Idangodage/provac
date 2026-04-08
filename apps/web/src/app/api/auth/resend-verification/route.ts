import { prisma } from "@provacx/database";
import { NextResponse } from "next/server";
import { z } from "zod";

import { sendEmailVerificationEmail } from "@/lib/email";
import { consumeRateLimit } from "@/lib/rate-limit";
import { getClientIpFromHeaders, isSameOriginRequest } from "@/lib/request";
import { generateRandomToken, sha256 } from "@/lib/tokens";

const schema = z.object({
  email: z.string().email().transform((v) => v.toLowerCase()),
});

export async function POST(request: Request) {
  try {
    if (process.env.NODE_ENV === "production" && !isSameOriginRequest(request)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const ip = getClientIpFromHeaders(request.headers) ?? "unknown";
    const ipLimit = consumeRateLimit({
      key: `auth:resend-verify:ip:${ip}`,
      windowMs: 60 * 60 * 1000,
      max: 20,
    });
    if (!ipLimit.ok) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    }

    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ ok: true });
    }

    const emailLimit = consumeRateLimit({
      key: `auth:resend-verify:email:${parsed.data.email}`,
      windowMs: 60 * 60 * 1000,
      max: 3,
    });
    if (!emailLimit.ok) {
      return NextResponse.json({ ok: true });
    }

    const user = await prisma.user.findUnique({
      where: { email: parsed.data.email },
      select: { emailVerified: true },
    });

    // Avoid email enumeration: always return ok.
    if (!user || user.emailVerified) {
      return NextResponse.json({ ok: true });
    }

    const identifier = `verify:${parsed.data.email}`;
    const token = generateRandomToken();
    const tokenHash = sha256(token);

    await prisma.verificationToken.deleteMany({
      where: { identifier },
    });

    await prisma.verificationToken.create({
      data: {
        identifier,
        token: tokenHash,
        expires: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    await sendEmailVerificationEmail({ email: parsed.data.email, token });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Resend verification error:", error);
    return NextResponse.json({ ok: true });
  }
}
