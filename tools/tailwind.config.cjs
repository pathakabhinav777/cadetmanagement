// Tailwind settings for cadetflow.css (built by tools/build_css.mjs; run `npm run build:css`
// after changing classes in index.html). Tailwind's default palettes are remapped so every
// utility class picks up the CadetFlow look (navy base, brass actions, NCC red, sky focus).
const path = require('node:path');
module.exports = {
  content: [path.join(__dirname, '..', 'index.html')],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Instrument Sans', 'system-ui', 'sans-serif'],
        mono: ['Instrument Sans', 'system-ui', 'sans-serif']
      },
      borderRadius: { md: '6px', lg: '8px', xl: '10px', '2xl': '14px' },
      colors: {
        slate:   { 50: '#F5F7FA', 100: '#EDF1F6', 200: '#DCE3EC', 300: '#BCC8D8', 400: '#91A3BC', 500: '#6B7F9C', 600: '#3E5476', 700: '#2A3D5C', 800: '#1B2B45', 900: '#132036', 950: '#0C1626' },
        amber:   { 50: '#FBF6E8', 100: '#F6EAC6', 200: '#EED793', 300: '#E5C46C', 400: '#D9B04F', 500: '#C99A35', 600: '#A97F27', 700: '#86631F', 800: '#5F4618', 900: '#3D2D10', 950: '#231A09' },
        rose:    { 50: '#FDF0F2', 100: '#FAD9DE', 200: '#F4B3BD', 300: '#EE8D9B', 400: '#E65D72', 500: '#D93049', 600: '#C8102E', 700: '#9C0C24', 800: '#72091A', 900: '#4A0611', 950: '#2C030A' },
        emerald: { 50: '#EEF8F3', 100: '#D3EEE1', 200: '#A6DCC3', 300: '#77C8A3', 400: '#4FB286', 500: '#35996E', 600: '#287C58', 700: '#1F6046', 800: '#174734', 900: '#0F3024', 950: '#081B14' },
        indigo:  { 50: '#EEF6FC', 100: '#D6EAF8', 200: '#AED5F1', 300: '#86C0E9', 400: '#6CB4E4', 500: '#4C98CF', 600: '#367BB0', 700: '#2A5F89', 800: '#204763', 900: '#163044', 950: '#0C1C29' },
        violet:  { 50: '#F3F1FC', 100: '#E3DEF8', 200: '#C8BEF1', 300: '#AC9EE8', 400: '#9483DE', 500: '#7C69D2', 600: '#6553B6', 700: '#4E4090', 800: '#392F69', 900: '#251F44', 950: '#161228' }
      }
    }
  }
};
