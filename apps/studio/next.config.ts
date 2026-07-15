import type { NextConfig } from "next"

// Adapted from creed's next.config.ts — kept the security header pattern,
// stripped Stripe/Supabase/GitHub-specific CSP allowances since this app
// only talks to our own context-agent API.
const csp = [
	"default-src 'self'",
	"script-src 'self' 'unsafe-inline'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: blob: https:",
	"font-src 'self' data:",
	`connect-src 'self' http://localhost:8787 http://127.0.0.1:31421 ${process.env.NEXT_PUBLIC_API_URL ?? ""}`,
	`frame-src 'self' http://localhost:8787 http://127.0.0.1:31421 ${process.env.NEXT_PUBLIC_API_URL ?? ""}`,
	"frame-ancestors 'self'",
	"base-uri 'self'",
	"form-action 'self'",
	"object-src 'none'",
].join("; ")

const securityHeaders = [
	{ key: "X-Content-Type-Options", value: "nosniff" },
	{ key: "X-Frame-Options", value: "SAMEORIGIN" },
	{ key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
	{ key: "Content-Security-Policy-Report-Only", value: csp },
]

const nextConfig: NextConfig = {
	output: "standalone",
	allowedDevOrigins: ["127.0.0.1", "localhost"],
	distDir: process.env.NEXT_DIST_DIR ?? ".next",
	reactStrictMode: true,
	poweredByHeader: false,
	experimental: { cpus: 2 },
	async headers() {
		return [{ source: "/:path*", headers: securityHeaders }]
	},
}

export default nextConfig
