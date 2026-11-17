/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        navy: "#102a43",
        teal: "#0f766e",
        canvas: "#f4f7f8",
      },
      boxShadow: {
        soft: "0 8px 26px rgba(16, 42, 67, 0.06)",
      },
    },
  },
  plugins: [],
};
