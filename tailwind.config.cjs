/** @type {import('tailwindcss').Config} */
module.exports = {
    darkMode: ["class", ".dark-theme"],
    content: [
        './src/**/*.{ts,tsx,js,jsx}',
        './index.html',
        './popup.html'
    ],
    theme: {
        extend: {},
    },
    plugins: [],
}
