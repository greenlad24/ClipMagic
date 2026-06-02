
import { Config } from "tailwindcss";

const tailwindConfig: Config = {
  darkMode: ["class"],
  content: ["src/**/*.{ts,tsx,css}"],
  theme: {
    extend: {
      "fontFamily": {
        "sans": [
          "var(--font-sans)",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "\"Segoe UI\"",
          "Roboto",
          "\"Helvetica Neue\"",
          "Arial",
          "\"Noto Sans\"",
          "sans-serif",
          "\"Apple Color Emoji\"",
          "\"Segoe UI Emoji\"",
          "\"Segoe UI Symbol\"",
          "\"Noto Color Emoji\""
        ],
        "mono": [
          "var(--font-mono)",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "Consolas",
          "\"Liberation Mono\"",
          "\"Courier New\"",
          "monospace"
        ]
      },
      "colors": {
        "border": "hsl(var(--border))",
        "input": "hsl(var(--input))",
        "ring": "hsl(var(--ring))",
        "background": "hsl(var(--background))",
        "foreground": "hsl(var(--foreground))",
        "primary": {
          "DEFAULT": "hsl(var(--primary))",
          "foreground": "hsl(var(--primary-foreground))"
        },
        "secondary": {
          "DEFAULT": "hsl(var(--secondary))",
          "foreground": "hsl(var(--secondary-foreground))"
        },
        "destructive": {
          "DEFAULT": "hsl(var(--destructive))",
          "foreground": "hsl(var(--destructive-foreground))"
        },
        "muted": {
          "DEFAULT": "hsl(var(--muted))",
          "foreground": "hsl(var(--muted-foreground))"
        },
        "accent": {
          "DEFAULT": "hsl(var(--accent))",
          "foreground": "hsl(var(--accent-foreground))"
        },
        "popover": {
          "DEFAULT": "hsl(var(--popover))",
          "foreground": "hsl(var(--popover-foreground))"
        },
        "card": {
          "DEFAULT": "hsl(var(--card))",
          "foreground": "hsl(var(--card-foreground))"
        },
        "sidebar": {
          "DEFAULT": "hsl(var(--sidebar-background))",
          "foreground": "hsl(var(--sidebar-foreground))",
          "primary": "hsl(var(--sidebar-primary))",
          "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
          "accent": "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          "border": "hsl(var(--sidebar-border))",
          "ring": "hsl(var(--sidebar-ring))"
        },
        "chart": {
          "1": "hsl(var(--chart-1))",
          "2": "hsl(var(--chart-2))",
          "3": "hsl(var(--chart-3))",
          "4": "hsl(var(--chart-4))",
          "5": "hsl(var(--chart-5))"
        }
      },
      "borderRadius": {
        "3xl": "calc(var(--radius) + 16px)",
        "2xl": "calc(var(--radius) + 8px)",
        "xl": "calc(var(--radius) + 4px)",
        "lg": "var(--radius)",
        "DEFAULT": "calc(var(--radius) - 2px)",
        "md": "calc(var(--radius) - 2px)",
        "sm": "calc(var(--radius) - 4px)"
      },
      "boxShadow": {
        "2xs": "var(--shadow-2xs)",
        "xs": "var(--shadow-xs)",
        "sm": "var(--shadow-sm)",
        "DEFAULT": "var(--shadow)",
        "md": "var(--shadow-md)",
        "lg": "var(--shadow-lg)",
        "xl": "var(--shadow-xl)",
        "2xl": "var(--shadow-2xl)"
      }
    },
  },
  plugins: [require("tailwindcss-animate"), require("@tailwindcss/typography")],
};

export default tailwindConfig;