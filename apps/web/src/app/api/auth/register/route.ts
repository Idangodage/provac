import { prisma } from "@provacx/database";
import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import { z } from "zod";


import { sendEmailVerificationEmail } from "@/lib/email";
import { consumeRateLimit } from "@/lib/rate-limit";
import { getClientIpFromHeaders, isSameOriginRequest } from "@/lib/request";
import { generateRandomToken, sha256 } from "@/lib/tokens";

const registerSchema = z.object({
  name: z.string().min(1).max(100).trim(),
  email: z.string().email().max(255).transform((v) => v.toLowerCase()),
  password: z.string().min(12).max(200),
});

export async function POST(request: Request) {
  try {
    // CSRF protection in production
    if (process.env.NODE_ENV === "production" && !isSameOriginRequest(request)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Rate limit by IP
    const ip = getClientIpFromHeaders(request.headers) ?? "unknown";
    const ipLimit = consumeRateLimit({
      key: `auth:register:ip:${ip}`,
      windowMs: 60 * 60 * 1000, // 1 hour
      max: 10,
    });
    if (!ipLimit.ok) {
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429 }
      );
    }

    // Validate input
    const parsed = registerSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input. Password must be at least 12 characters." },
        { status: 400 }
      );
    }

    const { name, email, password } = parsed.data;

    // Check if user exists
    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      return NextResponse.json(
        { error: "User already exists" },
        { status: 400 }
      );
    }

    // Hash password on server (12 rounds)
    const hashedPassword = await bcrypt.hash(password, 12);

    // Create user
    const user = await prisma.user.create({
      data: {
        name,
        email,
        password: hashedPassword,
      },
    });

    // Send email verification (fire-and-forget, don't block registration)
    try {
      const token = generateRandomToken();
      const tokenHash = sha256(token);

      await prisma.verificationToken.create({
        data: {
          identifier: `verify:${email}`,
          token: tokenHash,
          expires: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
        },
      });

      await sendEmailVerificationEmail({ email, token });
    } catch (emailError) {
      // Don't fail registration if email sending fails
      console.error("Failed to send verification email:", emailError);
    }

    return NextResponse.json({
      id: user.id,
      email: user.email,
      name: user.name,
    });
  } catch (error) {
    console.error("Registration error:", error);
    return NextResponse.json(
      { error: "Registration failed" },
      { status: 500 }
    );
  }
}
