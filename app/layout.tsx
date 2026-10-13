import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { ChatWidget } from "@/components/chat/ChatWidget";
import { Tracker } from "@/components/analytics/Tracker";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-jetbrains",
});

export const metadata: Metadata = {
  title: {
    default: "AdSense Check",
    template: "%s | AdSense Check",
  },

  description:
    "Check your website's AdSense readiness before you apply. Get detailed insights, blockers, and actionable fixes.",

  icons: {
    icon: [
      {
        url: "/favicon.png",
        type: "image/png",
      },
    ],
    shortcut: "/favicon.png",
    apple: "/favicon.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#ffffff",
  colorScheme: "light",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrains.variable}`}
    >
      <body className="bg-white text-cloud-50 antialiased">
        {children}
        {/* Support chat on public and customer pages; it hides itself on
            admin, checkout and invoice pages. */}
        <ChatWidget />
        {/* First-party, cookie-free visit analytics (off on admin pages). */}
        <Tracker />
      </body>
    </html>
  );
}
