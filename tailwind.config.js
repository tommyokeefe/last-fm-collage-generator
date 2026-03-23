import themePreset from "@tommyokeefe/theme/tailwind-preset";

/** @type {import('tailwindcss').Config} */
export default {
  presets: [themePreset],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {},
  },
  plugins: [],
};
