function getAppBaseUrl(): string {
  const explicit = process.env.AUTH_URL ?? process.env.NEXTAUTH_URL;
  if (explicit) return explicit.replace(/\/+$/, "");

  const vercel = process.env.VERCEL_URL;
  if (vercel) return `https://${vercel}`.replace(/\/+$/, "");

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Missing app base URL. Set AUTH_URL (preferred) or NEXTAUTH_URL."
    );
  }

  return "http://localhost:3000";
}

async function sendEmail(params: {
  to: string;
  subject: string;
  html: string;
}) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;

  if (!apiKey || !from) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Email service is not configured (RESEND_API_KEY/EMAIL_FROM).");
    }

    // Development fallback: log the email instead of sending.
    console.warn("[email] Not configured. Logging email instead:", {
      to: params.to,
      subject: params.subject,
    });
    console.log(params.html);
    return;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [params.to],
      subject: params.subject,
      html: params.html,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to send email (${res.status}): ${text}`);
  }
}

export async function sendEmailVerificationEmail(params: {
  email: string;
  token: string;
}) {
  const baseUrl = getAppBaseUrl();
  const verifyUrl = `${baseUrl}/api/auth/verify-email?token=${encodeURIComponent(
    params.token
  )}&email=${encodeURIComponent(params.email)}`;

  await sendEmail({
    to: params.email,
    subject: "Verify your email",
    html: `
      <div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; line-height: 1.4;">
        <h2 style="margin: 0 0 12px;">Verify your email</h2>
        <p style="margin: 0 0 12px;">
          Click the button below to verify your email address for ProvacX.
        </p>
        <p style="margin: 16px 0;">
          <a href="${verifyUrl}" style="display:inline-block;padding:10px 14px;background:#2563eb;color:#fff;border-radius:8px;text-decoration:none;">
            Verify email
          </a>
        </p>
        <p style="margin: 16px 0 0; font-size: 12px; color: #6b7280;">
          If you didn't request this, you can ignore this email.
        </p>
      </div>
    `,
  });
}

export async function sendPasswordResetEmail(params: {
  email: string;
  token: string;
}) {
  const baseUrl = getAppBaseUrl();
  const resetUrl = `${baseUrl}/reset-password?token=${encodeURIComponent(
    params.token
  )}&email=${encodeURIComponent(params.email)}`;

  await sendEmail({
    to: params.email,
    subject: "Reset your password",
    html: `
      <div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; line-height: 1.4;">
        <h2 style="margin: 0 0 12px;">Reset your password</h2>
        <p style="margin: 0 0 12px;">
          Click the button below to set a new password for your ProvacX account.
        </p>
        <p style="margin: 16px 0;">
          <a href="${resetUrl}" style="display:inline-block;padding:10px 14px;background:#2563eb;color:#fff;border-radius:8px;text-decoration:none;">
            Reset password
          </a>
        </p>
        <p style="margin: 16px 0 0; font-size: 12px; color: #6b7280;">
          This link expires soon. If you didn't request this, you can ignore this email.
        </p>
      </div>
    `,
  });
}
