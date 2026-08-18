import { Geist_Mono } from "next/font/google"
import localFont from "next/font/local"
import type { Metadata } from "next"
import { Toaster } from "@/components/ui/toaster"
import "./globals.css"

/**
 * Aeonik is a commercial face from CoType Foundry. The files in app/fonts must
 * be licensed copies before this ships — replace them in place, the filenames
 * are what this references.
 *
 * Only Regular and Bold are present. CSS weight matching therefore resolves
 * `font-medium` (500) down to 400 and `font-semibold` (600) up to 700, with no
 * synthetic emphasis. Dropping an Aeonik Medium beside these and adding it to
 * the array below restores the 500 tier the UI leans on in 43 places.
 */
const aeonik = localFont({
	src: [
		{ path: "./fonts/Aeonik-Regular.ttf", weight: "400", style: "normal" },
		{ path: "./fonts/Aeonik-Bold.ttf", weight: "700", style: "normal" },
	],
	variable: "--font-aeonik",
	display: "swap",
	// Metric-compatible stand-in while the face loads, so the swap does not
	// shift layout.
	fallback: ["Inter", "system-ui", "sans-serif"],
})

const geistMono = Geist_Mono({
	variable: "--font-geist-mono",
	subsets: ["latin"],
})

export const metadata: Metadata = {
	title: "Context Layer",
	description:
		"Local-first canvas for turning your design system into production UI.",
}

export default function RootLayout({
	children,
}: {
	children: React.ReactNode
}) {
	return (
		// The font variables belong on <html>: globals.css applies `font-sans`
		// there, and a variable defined on <body> is not visible to its own
		// parent. With them on <body> the declaration resolved to nothing and
		// every page fell back to Times.
		<html lang="en" className={`${aeonik.variable} ${geistMono.variable}`}>
			<body className="antialiased">
				{children}
				<Toaster />
			</body>
		</html>
	)
}
