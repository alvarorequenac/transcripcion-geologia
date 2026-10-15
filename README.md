# Estrato · Grabadora de clases

Aplicación web estática para grabar clases de Geología, transcribir audio en español y exportar apuntes a Word o PDF.

## GitHub Pages

El sitio se publica automáticamente con GitHub Actions cuando se actualiza la rama `main`. Está disponible en:

https://alvarorequenac.github.io/transcripcion-geologia/

## Configurar la transcripción segura con Groq

La clave de Groq no se debe pegar en la aplicación ni guardar en el repositorio. El backend de Cloudflare Workers la guarda como secreto y reenvía las solicitudes a Groq. El Worker solo acepta solicitudes desde este sitio, limita el uso a 18 solicitudes por IP cada 60 segundos y rechaza audios de más de 25 MB. Como el endpoint es público, configura también los límites de uso de tu cuenta de Groq.

1. Revoca cualquier clave que hayas compartido y crea una nueva en [Groq API Keys](https://console.groq.com/keys).
2. Instala Node.js y Wrangler, inicia sesión en Cloudflare y despliega el Worker desde la carpeta `workers/groq`:

   ```powershell
   Set-Location workers\groq
   npx wrangler login
   npx wrangler secret put GROQ_API_KEY
   npx wrangler deploy
   ```

   Pega la nueva clave en el prompt interactivo de Wrangler; no la pongas en un archivo ni en el chat. Wrangler mostrará la URL pública del Worker al desplegar.
3. En Estrato, elige **En la nube** y pega esa URL en **URL del backend seguro**, agregando `/transcribe` al final. La URL y las preferencias quedan en ese navegador; la clave permanece en Cloudflare.

El Worker restringe CORS al sitio de GitHub Pages. La limitación por IP ayuda a reducir abuso, pero no es autenticación; revisa los límites y el uso de tu cuenta de Groq.

## Uso

Abre el sitio con conexión HTTPS y autoriza el micrófono.

1. En **Grabar**, pulsa el botón rojo. Para terminar, púlsalo otra vez y confirma **Detener y guardar**.
2. Abre la clase guardada y pulsa **Transcribir en español**. La transcripción se guarda automáticamente en este dispositivo.
3. Al finalizar, abre la pestaña **Exportar** y elige **Word (.docx)** o **PDF**.

También puedes elegir transcripción local, que descarga un modelo de voz la primera vez y funciona sin conexión. Las grabaciones y transcripciones se guardan localmente en el navegador y no se sincronizan.

En Android, instala la aplicación desde el menú de Chrome. En iPhone, usa Safari → **Compartir → Agregar a inicio**.
