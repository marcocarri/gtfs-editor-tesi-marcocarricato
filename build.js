const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, 'src');
const distDir = path.join(__dirname, 'dist');

// verifica l'esistenza della cartella dist/
if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
}

console.log(' Avvio del processo di build...');

// legge i file sorgente (index.html, style.css, app.js) da src/
const indexHtml = fs.readFileSync(path.join(srcDir, 'index.html'), 'utf-8');
const css = fs.readFileSync(path.join(srcDir, 'style.css'), 'utf-8');
const js = fs.readFileSync(path.join(srcDir, 'app.js'), 'utf-8');

// formattazione corretta per il widget
// Snap4City vuole solo il container del widget quindi estrae tutto ciò che parte da <div id="busmap-container" fino alla chiusura </div>
const containerMatch = indexHtml.match(/<div id="busmap-container"[\s\S]*?<\/div>\s*<\/div>/);

// se non trova il doppio div finale, prende il blocco principale
let widgetHtml = containerMatch ? containerMatch[0] : null;

if (!widgetHtml) {
    // estrazione manuale tra l'inizio del container e la chiusura prima dello script
    const startIdx = indexHtml.indexOf('<div id="busmap-container"');
    const endIdx = indexHtml.lastIndexOf('</div>');
    if (startIdx !== -1 && endIdx !== -1) {
        widgetHtml = indexHtml.substring(startIdx, endIdx + 6);
    } else {
        console.error(' Errore: Impossibile trovare <div id="busmap-container"> in src/index.html');
        process.exit(1);
    }
}

// assemblaggio del file unico con l'integrazione di style.css e app.js
const bundleContent = `${widgetHtml}

<style>
${css}
</style>

<script>
${js}
</script>
`;

// scrittura in dist/bundle_widget.html
const outputPath = path.join(distDir, 'bundle_widget.html');
fs.writeFileSync(outputPath, bundleContent, 'utf-8');

console.log(` Build completata correttamente. File generato in: dist/bundle_widget.html`);