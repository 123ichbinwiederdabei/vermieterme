# Produktive Deployment-Abnahme am 09.10.2026

Der Nutzer hat Backup, Migration und Web-/Worker-Deployment ausdrücklich bestätigt. Der freigegebene Anwendungscode wurde mit zwei notwendigen Buildkorrekturen aus `main` ausgeliefert: gemeinsame Docker-Abhängigkeitsschichten verhindern unnötige Kopien auf dem VPS; `.gitattributes` erzwingt LF für den Linux-Entrypoint. Die Änderungen sind committet und nach `origin/main` gepusht.

## Ausgelieferter Stand

- Git-Revision: `c8d1919b59659c11d5f256380a858d8ac595d386`.
- Image: `img-captain-vermieterme:17-chatgpt-c8d1919`.
- Image-ID: `sha256:2eb107d330ea7db85f712c8cda845a1c8209a0e9a0e7f94f98dafd59f8b0659e`.
- Web: `srv-captain--vermieterme`, 1/1, healthy, keine Neustarts.
- Worker: `srv-captain--vermieterme-worker`, 1/1, healthy, keine Neustarts.
- Beide Dienste verwenden `captain--vermieterme-data:/app/data` und sind auf denselben Swarm-Knoten festgelegt. Der Worker setzt `INVOICE_WORKER_MODE=1` und veröffentlicht keinen HTTP-Port. Er ist ein separater Docker-Swarm-Service; seine Verwaltung erfolgt über Docker, nicht als eigener Web-Eintrag in der CapRover-Oberfläche.
- Die bestehenden Runtime-Bindings wurden erhalten; es wurden keine Microsoft- oder Google-Zugangsdaten neu übernommen.

## Sicherung und Erhaltung

Die private Releaseablage liegt unter `/var/backups/vermieterme/releases/20261009-chatgpt-a8bc7bb`. Die maßgebliche Sicherung unmittelbar vor dem erfolgreichen Umstieg ist `cutover-backup-retry1/`; sie enthält die konsistente SQLite-Sicherung, `uploads.tar.gz` und ein Hashmanifest. Alte Service-/CapRover-Konfiguration, Buildprotokolle, Migrationsprobe und Deploymentnachweis bleiben privat auf dem VPS. Das vorherige Image `img-captain-vermieterme:16-mcp-20261008` bleibt erhalten.

SQLite-Backup-API, `integrity_check`, `foreign_key_check` und isolierte Upload-Wiederherstellung sind bestanden: 61 Tabellen, fünf Originaldateien, fünf referenzierte Dateien. Das bisherige Web-Image startete mit der wiederhergestellten Sicherung und lieferte HTTP 200. Die additive Migration `20261008230000_end_to_end_chatgpt` wurde zuerst an einer isolierten Kopie und dann bei angehaltenem Webdienst produktiv angewendet. Vor dem Start des neuen Workers wurden alle bisherigen Spaltenwerte aller 60 Fachtabellen sowie sämtliche Originalhashes mit der aktuellen Sicherung verglichen; sie blieben unverändert.

Der erste Startversuch scheiterte an CRLF im exportierten Entrypoint. Der Deploymentablauf stellte Datenbank und bisherigen Service automatisch wieder her; dessen öffentliche Health-Prüfung und Datenbankintegrität wurden erneut bestätigt. Nach der LF-Korrektur wurden neues Web und Worker vor dem erneuten Umstieg isoliert gestartet. Web lieferte HTTP 200; der Worker erledigte einen Hintergrundjob ohne Fehler oder Neustart.

Ein Rollback erfordert das Anhalten beider Dienste, die Wiederherstellung der passenden Datenbank und Originaldateien, Hash-/Integritätsprüfung und anschließend das vorherige Image. Keine bloße Image-Rücksetzung gegen die neue Datenbank vornehmen. Die private alte Service-Konfiguration dokumentiert die ursprünglichen Einstellungen.

## Live-Abnahme

- Der Linux-Produktionsbuild einschließlich TypeScript und Workerbundle ist bestanden. Die zuvor bestandenen 158 Tests und sechs Playwright-Prüfungen gelten für denselben unveränderten Fachcode; die nachfolgenden Änderungen betreffen Build und Dokumentation.
- `https://mieter.mtbaco.com/api/health` liefert HTTP 200. Die Paketversion bleibt 1.0.9; Git-/Image-ID und neue Workflow-Oberfläche identifizieren den ausgelieferten Stand.
- `prisma migrate status`: alle 13 Migrationen angewendet. Vergleich der produktiven Datenbank mit dem ausgelieferten Prisma-Schema: keine Differenz. Integrität `ok`, keine Fremdschlüsselfehler.
- OAuth-Metadaten auf beiden öffentlichen Well-known-Endpunkten liefern HTTP 200 und getrennte read/write/admin/approve-Scopes.
- Der echte VermieterMe-Connector in ChatGPT liefert 74 Entitätstypen und liest das bestehende Objekt. Generische Schreibzugriffe auf Fachstammdaten sowie Archiv-/Abrechnungshistorie sind gesperrt.
- Im angemeldeten Browser ist `/workflow` erreichbar. Die unveränderte Restperiode 13.09.–31.12.2026 wurde ausschließlich geprüft. Fehlende aktive Kostenarten, fehlende aktuelle Berechnungen und nicht eingerichtete OneDrive-Ablage erscheinen als konkrete Freigabesperren. Es wurde keine PDF erstellt oder Abrechnung freigegeben.
- Beide laufenden Container haben exakt dieselbe Image-ID; beide Healthchecks sind grün. Der Web-Healthcheck prüft HTTP, der Worker-Healthcheck seine Datenbankverbindung. Ein produktiver Hintergrundjob ist DONE; keine Worker-Verarbeitungsfehler wurden festgestellt.
- OneDrive wurde erneut ausschließlich lesend geprüft: Zielordner weiterhin leer. Datenbank: keine Storage-Konfiguration, keine Microsoft-Quelle und kein Versandauftrag.
- Nur eigene fehlgeschlagene Buildcontainer/-images und eigene Builder-Zwischenimages wurden entfernt. Bisheriges und neues Produktionsimage, Sicherungen, andere Dienste und Volumes bleiben erhalten. Danach waren rund 3,6 GB frei.

## Noch gesondert einzuführen

Microsoft-Runtime-Secrets, App-Prinzipal-/Rechteprüfung, ausgewählte Mail-/Drive-Quellen, explizite OneDrive-Schreibaktivierung, echte Belege und Krandorf-Vertrags-/Regelnachweise sowie ein ausdrücklich bestätigter Testempfänger bleiben offen. Auch die Google-Vision-Bindings fehlen bislang im VermieterMe-Runtime. Ohne diese Schritte ist der vollständige Import → OCR → Buchung → Freigabe → Cloud-PDF → Versand-Abnahmelauf noch nicht durchgeführt. Für neue ChatGPT-Fachaktionen gegebenenfalls den Connector-Werkzeugkatalog aktualisieren; zusätzliche OAuth-Rechte müssen ausdrücklich autorisiert werden.

Bei späteren Releases immer Web und separaten Worker gemeinsam auf dasselbe geprüfte Image aktualisieren und diese Parität erneut bestätigen. Die tatsächlichen Swarm-Image-IDs sind maßgeblich; eine CapRover-Anzeige allein genügt nicht als Deploymentnachweis.
