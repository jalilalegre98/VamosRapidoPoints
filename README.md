# VamosRapido · Sistema de recompensas

App web para celulares: registro y login con email verificado, puntos por compra, tienda de premios y cupones, caja para el personal con QR / NFC / búsqueda, y panel de administración.

**Stack:** Node.js + Express · PostgreSQL · HTML/JS sin framework.

## Roles
- **Cliente:** se registra, confirma su email, suma puntos, canjea premios, muestra su QR.
- **Administrador (`ADMIN_USER`, por defecto `JalilAlegre`):** solo ve *Caja* y *Admin*. Se crea solo al iniciar el servidor con `ADMIN_EMAIL` y `ADMIN_PASSWORD`. Nadie puede registrarse con ese usuario.

## Publicar en GitHub
1. Crea un repositorio **privado** en GitHub (por ejemplo `vamosrapido-recompensas`).
2. Sube todo el contenido de esta carpeta (el archivo `.env` real **no** se sube; está en `.gitignore`).

## Publicar en Northflank
1. En Northflank, crea un **Project** y elige la región más cercana a tus clientes.
2. **Base de datos:** *Create new → Addon → PostgreSQL*. Cuando esté lista, en *Connection details* copia la cadena de conexión.
3. **Servicio:** *Create new → Service → Combined (build and deploy)*. Conecta tu cuenta de GitHub, elige el repositorio y la rama `main`. Selecciona el build con **Dockerfile** (ruta `/Dockerfile`).
4. **Puerto:** agrega el puerto `3000`, protocolo HTTP, y márcalo como **público**.
5. **Variables de entorno** (sección *Environment*), copiando los nombres de `.env.example`:
   `DATABASE_URL`, `DB_SSL`, `JWT_SECRET`, `APP_URL`, `ADMIN_USER`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`.
   - Si la conexión del addon exige SSL, pon `DB_SSL=true`.
   - `JWT_SECRET`: una cadena larga y aleatoria. Si la cambias, todos los usuarios deberán volver a ingresar.
6. Despliega. Northflank te da una URL pública; ponla en `APP_URL` (sin barra final) y vuelve a desplegar. Más adelante puedes agregar tu **dominio propio** (HTTPS incluido) y actualizar `APP_URL`.
7. Cada `git push` a `main` vuelve a construir y publicar solo.

> **Importante:** `APP_URL` define el enlace de los emails y el enlace que se graba en los llaveros. Si después cambias de dominio, los llaveros ya grabados apuntarán al dominio viejo. Define el dominio definitivo **antes** de grabar llaveros.

## Emails de verificación
La app envía el email por **SMTP**. Cualquier proveedor sirve (Brevo, Resend, Mailgun, Gmail con "clave de aplicación"). Crea la cuenta, obtén host, puerto, usuario y clave SMTP, y cárgalos como variables. Para que los emails no caigan en spam, configura en tu proveedor la verificación de dominio (SPF/DKIM).
Sin `SMTP_HOST` la app funciona pero imprime el enlace de verificación en los logs (útil para pruebas).

## Llavero NFC y QR (iPhone y Android)
Cada llavero guarda un **enlace**: `https://tu-dominio.com/c/<usuario>`. El QR del cliente contiene el mismo enlace.

- **Leer con iPhone (XS o posterior):** acercar el llavero al iPhone abre una notificación; al tocarla se abre la ficha del cliente en *Caja* (el empleado debe haber iniciado sesión como administrador en ese navegador).
- **Leer con Android:** acercar el llavero con NFC activado funciona igual, o dentro de la app con el botón *Leer llavero NFC* (Chrome).
- **QR:** *Escanear QR del cliente* (cámara en vivo) o *Tomar foto del QR*. También sirve la cámara nativa del celular.
- **Grabar el llavero:** el cliente, desde un Android con Chrome, usa *Grabar llavero* en su pantalla de inicio. En iPhone, el negocio puede grabarlo con la app gratuita **NFC Tools** (Write → Add a record → URL). Compra chips **NTAG213 o NTAG215**.
- Para evitar que alguien regrabe el llavero, se puede bloquear (*Lock tag*) después de grabarlo. Es irreversible.

## Seguridad incluida
Contraseñas con bcrypt, sesión en cookie `httpOnly`, límite de intentos de login y registro, email único y verificado, y canjes validados en el servidor dentro de una transacción (no se puede gastar dos veces el mismo saldo). Los puntos solo los suma el administrador.

## Desarrollo local
```
npm install
cp .env.example .env   # y completa los valores
export $(grep -v '^#' .env | xargs) && npm start
```
Necesitas una base PostgreSQL local o la de Northflank accesible desde tu equipo.

## Límites conocidos
- El administrador es una sola cuenta. Para varios empleados con permisos propios habría que agregar más roles.
- No hay recuperación de contraseña por email todavía.
- No hay respaldo automático configurado: activa los backups del addon en Northflank.
