const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, 'src');
const distDir = path.join(__dirname, 'dist');

// verifica l'esistenza della cartella dist/
if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
}

console.log(' Avvio del processo di build');

// legge i file sorgente (index.html, style.css, app.js) da src/
const indexHtml = fs.readFileSync(path.join(srcDir, 'index.html'), 'utf-8');
const css = fs.readFileSync(path.join(srcDir, 'style.css'), 'utf-8');
const js = fs.readFileSync(path.join(srcDir, 'app.js'), 'utf-8');

// estrazione di tutto ciò che è dentro body
const bodyStart = indexHtml.indexOf('<body>') + 6;
const bodyEnd = indexHtml.lastIndexOf('</body>');

if (bodyStart === 5 || bodyEnd === -1) {
    console.error(' Errore: Impossibile trovare i tag <body> nel file index.html');
    process.exit(1);
}

let widgetHtml = indexHtml.substring(bodyStart, bodyEnd).trim();

// rimozione del tag script di app.js
widgetHtml = widgetHtml.replace(/<script src="app\.js"><\/script>/g, '');

// reinserimento forzato delle dipendenze esterne
const jqueryImport = '<script src="https://ajax.googleapis.com/ajax/libs/jquery/3.7.1/jquery.min.js"></script>\n';
const turfImport = '<script src="https://cdn.jsdelivr.net/npm/@turf/turf@6/turf.min.js"></script>\n';

// assemblaggio del file unico con l'integrazione di style.css e app.js
const bundleContent = `${jqueryImport}{turfImport}
${widgetHtml}
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