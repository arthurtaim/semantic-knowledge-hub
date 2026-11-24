# Public link WITH A LOGIN for the PERSONAL TEST stack (SKH_PUBLIC_CADDYFILE=Caddyfile.login). The app stays bound to
# loopback; this gateway forwards to the frontend container with `Host: 127.0.0.1`, so the backend's host guard
# and fail-closed start-up checks are unchanged. A login (basic auth) keeps bots that scan the IP from using
# the owner's Claude subscription.
#
#   http://{$SKH_PUBLIC_IP}       — plain HTTP by IP (always works)
#   https://{$SKH_PUBLIC_HOST}    — HTTPS with an automatic Let's Encrypt certificate (e.g. <ip-with-dashes>.sslip.io)

(app) {
	basic_auth {
		import /etc/caddy/auth/users
	}
	reverse_proxy frontend:8080 {
		header_up Host 127.0.0.1
		# M6: requests through this public gateway are marked; the task module answers them read-only.
		header_up X-SKH-Exposure public
		flush_interval -1
	}
}

http://{$SKH_PUBLIC_IP} {
	import app
}

{$SKH_PUBLIC_HOST} {
	import app
}
