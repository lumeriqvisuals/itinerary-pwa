/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        forest: "#132b2a",
        moss: "#71836a",
        cream: "#f7f6f0",
        paper: "#fffefa",
        ink: "#202827",
        muted: "#7c8580",
        line: "#e5e8e0",
        apricot: "#e8a878"
      },
      boxShadow: {
        soft: "0 18px 55px rgba(24, 44, 39, 0.08)"
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"]
      }
    }
  },
  plugins: []
};
