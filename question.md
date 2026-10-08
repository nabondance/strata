# Questions for the maintainer

- Which private contact address or channel should security reporters use when GitHub private vulnerability reporting is unavailable? `SECURITY.md` currently tells them to open an issue requesting a private channel without sharing exploit details.
- Should a later release offer explicit API-based counts for Claude and Gemini? These would require credentials and send Git-tracked instruction text to the provider; the current plan keeps all measurement local.
- Please sign in to npm on this machine (or provide a secure publishing path) for the first `context-strata` release. `npm whoami` returned `ENEEDAUTH` on 2026-10-08. The public registry returned `{"error":"Not found"}` for the package name, so the name is still unclaimed rather than reserved. I have not published or tagged v0.1.0.
