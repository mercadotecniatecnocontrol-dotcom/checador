# Checadas para Recursos Humanos

Página para que RH vea las checadas del checador facial Hikvision (DS-K1T323EBWX-E1) y descargue el historial en Excel.

```
Checador Hikvision ──(HTTPS, al momento de checar)──► Vercel ──► Supabase ◄── Página de RH
```

El checador manda cada checada solo, por HTTPS, a una dirección secreta de Vercel. No hace falta ninguna computadora encendida.

## 1. Supabase (una vez)
En *SQL Editor* corre `sql/001_checador.sql`.

## 2. Vercel: variables (Settings › Environment Variables)

| Variable | Valor |
|---|---|
| `SUPABASE_URL` | `https://vlbyjoqessxcmkejcujp.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | llave service_role (Supabase › Settings › API) |
| `PIN_RH` | PIN que usará RH para entrar |
| `HIKVISION_TOKEN` | clave secreta que inventes: solo letras y números, 20 o más (ej. `Tc7kQ2m9Xv4LpR8wZs3N`) |
| `ZONA_HORARIA` | `America/Chihuahua` |
| `HORA_ENTRADA` | `08:30` |
| `TOLERANCIA_MIN` | `10` |

Después de agregar o cambiar variables: *Deployments › ⋯ › Redeploy*.

## 3. Checador: HTTP Listening
En la página del checador (desde computadora): *Configuración › Red › HTTP Listening*.

| Campo | Valor |
|---|---|
| Event Alarm IP/Domain Name | el dominio de Vercel, sin `https://` (ej. `checador-rh.vercel.app`) |
| URL | `/hk/` + tu `HIKVISION_TOKEN` (ej. `/hk/Tc7kQ2m9Xv4LpR8wZs3N`) |
| Port | `443` |
| Protocol | `HTTPS` |

Guarda y checa con tu rostro. En la página de RH, arriba a la derecha, debe aparecer «Última checada recibida hace un momento».

Para comprobar la dirección desde el navegador: abre `https://tu-dominio.vercel.app/hk/TU_CLAVE`. Debe decir «listo para recibir checadas».

## Cómo se calcula
- Primera checada del día = entrada; la última = salida. Si alguien sale a comer y regresa, el tiempo se suma por pares.
- Retardo = entrada después de la hora asignada más la tolerancia.
- Día pasado con número impar de checadas = «Falta checada de salida».

## Carpeta `puente/` (opcional)
Ya no es necesaria para el día a día. Solo sirve si quieres importar una vez las checadas viejas que ya están guardadas en el checador (ver `puente/.env.example`).
