# ZHEND’OR Joyería

Tienda virtual de joyería con estética crema, champán, dorado suave y sombras
botánicas. Catálogo administrable desde un panel privado y **compras gestionadas
directamente por WhatsApp** (sin pasarelas de pago).

## Tecnologías

- **Backend:** Node.js puro (módulo `http`) + `node:sqlite` integrado. Sin
  dependencias externas, sin compilación nativa.
- **Base de datos:** SQLite persistente en `data/zhendor.db`.
- **Imágenes:** subida en base64 y almacenadas en `uploads/`.
- **Frontend:** HTML, CSS y JavaScript vanilla, responsive.
- **Autenticación:** usuario/correo + contraseña con hash `scrypt`; sesión con
  token aleatorio en cookie `HttpOnly` y `SameSite=Strict`.

Requiere **Node.js 22.5 o superior** (usa `node:sqlite`).

## Ejecutar en local

```bash
# 1. (Opcional) crea tu archivo de entorno a partir del ejemplo
copy .env.example .env      # Windows
# cp .env.example .env      # macOS / Linux

# 2. Inicia el servidor
npm start
```

Se abre en http://localhost:3000

La primera vez, el servidor crea la base de datos, los ajustes por defecto y
**6 productos de ejemplo** que puedes editar o eliminar desde el panel.

## Acceder al panel de administración

- URL: http://localhost:3000/admin (o `/login`)
- Usuario inicial: el definido en `ADMIN_USER` del archivo `.env` (por defecto
  `admin`). También puedes escribir el correo, si lo usas como usuario.
- Contraseña inicial: la definida en `ADMIN_PASSWORD` del archivo `.env`
  (por defecto `Cambiar123*`).

La sesión se guarda en una cookie `HttpOnly`, así que las rutas `/admin` y
`/admin.html` quedan protegidas en el servidor: si no has iniciado sesión, el
navegador te redirige a `/login` (y entrar a `/login` con sesión activa te lleva
de vuelta al panel). El botón **Cerrar sesión** invalida el token en el servidor.

> **Importante:** cambia las credenciales antes de publicar el sitio. Al usar
> `npm run set-admin` no hace falta borrar la base de datos.

### Cambiar las credenciales

```bash
# Interactivo (pregunta usuario y contraseña)
npm run set-admin

# Directo
npm run set-admin -- --user admin@tudominio.com --password "TuClaveSegura123*"
```

El comando actualiza el usuario y/o la contraseña, guarda el hash `scrypt` y
**cierra todas las sesiones activas**. Reinicia el servidor si está en ejecución.

## Configurar WhatsApp

1. Entra al panel → pestaña **Configuración**.
2. En **WhatsApp** escribe el número **con prefijo internacional y sin signos**:
   por ejemplo `573001234567` (57 = Colombia, 3001234567 = número).
3. Opcional: define el **costo de envío** en pesos. Si lo dejas vacío, la tienda
   mostrará «Por confirmar» y el total lo cierras por chat.

## Agregar y gestionar productos

En el panel, pestaña **Productos**:

- **Nuevo producto**: nombre, descripción, precio (COP), presentación, estado
  (disponible / agotado), publicación (publicado / oculto) y fotografía. El
  precio se escribe sin decimales y puedes usar puntos como separador de miles
  (por ejemplo `113.900` = 113900).
- **Editar** (lápiz) y **Eliminar** (papelera, con confirmación).
- Los productos **ocultos** no aparecen en la tienda.
- Los productos **agotados** se muestran con la etiqueta «Agotado» y **no
  permiten comprar**.

Los cambios se reflejan de inmediato en el catálogo público.

## Descuentos

En el panel, pestaña **Descuentos**, elige un producto y configura:

- **Tipo**: sin descuento, porcentaje (%) o valor fijo (COP).
- **Valor**: el porcentaje o el monto a descontar. No se permite un porcentaje
  superior a 100 ni un valor fijo mayor que el precio.
- **Activo**: interruptor para encender o apagar el descuento.
- **Fechas** (opcionales): inicio y fin en formato `AAAA-MM-DD`. El fin se
  interpreta hasta el final del día. Si no hay fechas, el descuento aplica
  siempre que esté activo.

La tienda muestra el precio anterior tachado, el precio final y una etiqueta
(ej. `-20%`). El **precio final siempre lo calcula el servidor**, tanto en el
catálogo como en la cotización del pedido, para que no pueda manipularse desde
el navegador.

## Flujo de compra

1. La clienta elige una pieza → **Ver producto** → **Comprar**.
2. Completa nombre, teléfono, ciudad, dirección y observaciones.
3. Revisa subtotal, descuento (si aplica), envío y total. El servidor cotiza el
   pedido para confirmar el precio final.
4. Pulsa **Continuar por WhatsApp**: se abre `https://wa.me/<número>` con el
   mensaje ya redactado. El pedido se confirma cuando la clienta lo **envía**
   desde WhatsApp.

## Pruebas

```bash
npm test                 # Pruebas de humo de la API (sin navegador)
npm run test:responsive  # Pruebas responsive con Chrome/Edge headless
```

- `test/smoke.mjs`: arranca el servidor en un puerto de prueba con una base
  temporal y valida catálogo, autenticación (usuario/contraseña, cookie y
  protección de `/admin`), CRUD de productos, descuentos y cotización, subida
  de imágenes, validaciones, logotipo, ajustes, placeholder, seguridad y
  generación del enlace de WhatsApp.
- `test/responsive.mjs`: abre la tienda y el panel en Chrome o Edge en modo
  headless (vía CDP) y verifica que no haya desbordamiento horizontal, que el
  formulario de compra sea usable en móvil (incluido con teclado emulado) y que
  el panel de administración (login y secciones) funcione en PC y móvil. Guarda
  capturas en una carpeta temporal.

## Estructura del proyecto

```
.
├── server.js            Servidor HTTP, rutas de API, auth, subida de imágenes
├── db.js                Esquema SQLite, migraciones, semilla y hash de contraseña
├── pricing.js           Cálculo de precios, descuentos y cotizaciones
├── package.json
├── scripts/
│   └── set-admin.js     Cambio de credenciales del administrador
├── .env / .env.example  Configuración (puerto, usuario, contraseña, sesión)
├── data/                Base SQLite e imágenes subidas (se generan, dentro de DATA_DIR)
├── public/
│   ├── index.html       Tienda pública
│   ├── login.html       Acceso al panel
│   ├── admin.html       Panel de administración
│   ├── css/style.css    Estilos de la tienda
│   ├── css/admin.css    Estilos del panel
│   ├── js/site.js       Lógica de la tienda
│   ├── js/admin.js      Lógica del panel
│   └── js/message.js    Generación del mensaje/enlace de WhatsApp
└── test/
    ├── smoke.mjs        Pruebas de humo de la API
    └── responsive.mjs   Pruebas responsive con navegador real
```

## API (resumen)

| Método | Ruta | Descripción |
| --- | --- | --- |
| GET | `/api/products` | Catálogo público (solo publicados, con precio final) |
| GET | `/api/products/:id` | Producto publicado |
| GET | `/api/settings` | Configuración pública |
| POST | `/api/order/quote` | Cotiza un pedido (precio final, descuento, envío, total) |
| POST | `/api/admin/login` | Inicia sesión con usuario y contraseña |
| POST | `/api/admin/logout` | Cierra sesión (invalida el token) |
| GET | `/api/admin/me` | Datos de la sesión actual (protegida) |
| GET | `/api/admin/products` | Lista completa (protegida) |
| POST | `/api/admin/products` | Crear producto (protegida) |
| PUT | `/api/admin/products/:id` | Editar producto y descuento (protegida) |
| DELETE | `/api/admin/products/:id` | Eliminar producto (protegida) |
| GET/PUT | `/api/admin/settings` | Leer/editar configuración (protegida) |

Las rutas de administración aceptan la cookie de sesión `zhendor_session` o la
cabecera `Authorization: Bearer <token>`. El panel usa la cookie.

## Despliegue en producción

La base de datos vive en `data/zhendor.db` y las imágenes subidas en
`data/uploads/` (heredan de `DATA_DIR`). Ambos deben vivir en un **volumen
persistente** en tu proveedor de hosting, o se perderán con cada redespliegue.

### En Render (plataforma)

1. Sube este proyecto a un repositorio de GitHub (el `.gitignore` ya excluye
   `.env`, `data/` y `uploads/`).
2. En Render: **New → Web Service**, conecta el repositorio.
3. Configuración básica:
   - Runtime: `Node` — Version: `24` (usamos `node:sqlite`, requiere Node ≥ 22.5).
   - Build command: `npm install` — Start command: `npm start`.
4. Variables de entorno:
   - `ADMIN_USER`, `ADMIN_PASSWORD` (seguras, se usan en la primera ejecución)
   - `SESSION_DAYS=7`, `COOKIE_SECURE=true` (obligatorio, tu sitio es HTTPS)
   - `NODE_VERSION=24`
5. **Disco persistente** (para HTTPS o Plan oficial): crea un **Disk** con punto
   de montaje `/data` y define `DATA_DIR=/data`. Sin disco, la base y las
   imágenes se resetean en cada despliegue.
6. Despliega. Render inyecta `PORT` automáticamente y te da una URL con HTTPS
   (p. ej. `https://zhendor.onrender.com`). Puedes añadir un **Custom Domain**
   allí mismo.

### En Railway (plataforma)

1. Sube el proyecto a GitHub.
2. **New Project → Deploy from GitHub repo**.
3. En la pestaña *Variables*: `ADMIN_USER`, `ADMIN_PASSWORD`, `SESSION_DAYS=7`,
   `COOKIE_SECURE=true`, `NODE_VERSION=24`.
4. En *Volumes*: crea uno montado en `/data` y define `DATA_DIR=/data`.
5. Railway inyecta `PORT` y te da HTTPS.

### En un VPS (DigitalOcean, Hetzner, Vultr…)

1. **Servidor**: cualquier VPS con Node.js 22.5+. Sube el proyecto (sin `.env`,
   `data/` ni `uploads/`, que se regeneran).
2. **Variables**: crea `.env` con `PORT`, `ADMIN_USER`, `ADMIN_PASSWORD`
   (segura), `SESSION_DAYS` y `COOKIE_SECURE=true` (obligatorio bajo HTTPS).
   Opcional: `DATA_DIR` (o `UPLOADS_DIR`) para apuntar la base y las imágenes a
   otra ruta.
3. **Proceso**: mantén el servidor vivo con un gestor (por ejemplo `pm2`):
   ```bash
   npm i -g pm2
   pm2 start server.js --name zhendor
   pm2 save
   ```
4. **Proxy inverso**: publica con Nginx/Caddy y certificado HTTPS, apuntando a
   `http://localhost:3000`.
5. **Copias de seguridad**: respalda periódicamente `data/zhendor.db` y
   `data/uploads/` — contienen tu catálogo e imágenes (un solo directorio).

El archivo `.env.example` no contiene credenciales reales; el `.env` real no debe
subirse al repositorio (ya está en `.gitignore`).
