PLATAFORMA ACADEMICA UAN — V20

CORRECCIONES INCLUIDAS
1. Coordinador:
   - Menu "Notas y correcciones".
   - Puede modificar notas durante todo el semestre, incluso con acta publicada.
   - Cada cambio queda marcado como "editado por coordinación" con nombre y fecha.
   - Si corrige una nota de un acta ya publicada, se actualiza la definitiva oficial del estudiante.
   - Menu "Fecha limite de actas" para definir dia y hora hasta la cual los docentes pueden registrar/cerrar notas.

2. Docente:
   - Antes del limite puede registrar notas.
   - Despues del limite queda en solo lectura.
   - Un acta publicada queda en solo lectura para el docente.
   - El docente no puede reabrir actas; Coordinacion es quien puede hacerlo.
   - La definitiva y el estado se actualizan en vivo mientras escribe una nota.

3. Estudiante:
   - Nueva vista de "Mis calificaciones" con tarjetas por asignatura.
   - Muestra definitiva, estado, grupos, creditos y progreso.
   - Diferencia notas oficiales de notas en proceso.
   - El detalle muestra los items, porcentajes y correcciones realizadas por Coordinacion.
   - El placeholder de foto usa fondo oscuro para evitar el aspecto blanco vacio.

4. Supabase:
   - La fecha limite se sincroniza reutilizando la tabla config_evaluacion mediante la fila reservada __GLOBAL_ACTAS__.
   - Las notas siguen sincronizandose por fila.
   - La metadata de correccion viaja dentro de la fila de notas en _meta.

PUBLICACION
Reemplazar en el repositorio GitHub Pages los archivos index.html, app.js, estilos.css y los recursos graficos incluidos.
El sitio se sigue usando directamente desde:
https://jairoacardozo15.github.io/X/

No se requiere que docentes o estudiantes descarguen ningun archivo.
