Assets generados desde el logo original de Manos Libres.

logo.png           512x512  logo completo (manos + texto) - icono principal PWA
logo-192.png       192x192  logo completo - icono chico y apple-touch-icon
logo-maskable.png  512x512  logo completo dentro de la zona segura del 60%
                            central. Android recorta hasta un 20% por lado
                            segun la forma de mascara del launcher.
logo-mark.png      256x256  solo el circulo de manos, sin texto - para el header
                            de la app, donde a 36px el texto no se leeria.
favicon.png         64x64   marca sola, para la pestaña del navegador.

Fondo: #0e0e10 (variable --bg), para que empalme con la app sin borde visible.

Si se regeneran, mantener el fondo solido. Los PNG con transparencia quedan mal
en los launchers de Android, que ponen fondo blanco por defecto.
