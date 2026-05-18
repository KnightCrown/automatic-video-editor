/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        background: '#0F111A',
        surface: '#1A1D27',
        primary: '#6366F1',
        primaryHover: '#4F46E5',
        textMain: '#F8FAFC',
        textMuted: '#94A3B8',
        border: '#2D313E',
        success: '#10B981',
        danger: '#EF4444',
      }
    },
  },
  plugins: [],
}
