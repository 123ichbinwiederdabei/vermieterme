# Produktive Deployment-Abnahme am 09.10.2026

Aktueller Stand nach der rclone-Abnahme: Anwendung `a2e9fd3`, Image `img-captain-vermieterme:19-rclone-a2e9fd3`, beide Dienste healthy und 1/1. Die folgenden Abschnitte dokumentieren zunächst den ursprünglichen Stand 17; die abschließende rclone-Abnahme unten ist für den aktuellen Betrieb maßgeblich.

Der Nutzer hat Backup, Migration und Web-/Worker-Deployment ausdrücklich bestätigt. Der freigegebene Anwendungscode wurde mit zwei notwendigen Buildkorrekturen aus `main` ausgeliefert: gemeinsame Docker-Abhängigkeitsschichten verhindern unnötige Kopien auf dem VPS; `.gitattributes` erzwingt LF für den Linux-Entrypoint. Die Änderungen sind committet und nach `origin/main` gepusht.

## Ausgelieferter Stand

- Git-Revision: `c8d1919b59659c11d5f256380a858d8ac595d386`.
- Image: `img-captain-vermieterme:17-chatgpt-c8d1919`.
- Image-ID: `sha256:2eb107d330ea7db85f712c8cda845a1c8209a0e9a0e7f94f98dafd59f8b0659e`.
- Web: `srv-captain--vermieterme`, 1/1, healthy, keine Neustarts.
- Worker: `srv-captain--vermieterme-worker`, 1/1, healthy, keine Neustarts.
- Beide Dienste verwenden `captain--vermieterme-data:/app/data` und sind auf denselben Swarm-Knoten festgelegt. Der Worker setzt `INVOICE_WORKER_MODE=1` und veröffentlicht keinen HTTP-Port. Er ist ein separater Docker-Swarm-Service; seine Verwaltung erfolgt über Docker, nicht als eigener Web-Eintrag in der CapRover-Oberfläche.
- Beim ersten Deployment wurden die bestehenden Runtime-Bindings erhalten. Die nachfolgend ausdrücklich freigegebene Microsoft-Aktivierung ist unten dokumentiert; Google-Vision-Bindings wurden weiterhin nicht übernommen.

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

Ausgewählte Mail-/Drive-Quellen, die technisch erfolgreiche OneDrive-Schreibaktivierung sowie widerspruchsfreie, bestätigte Krandorf-Vertrags-/Regelnachweise bleiben offen. Die grundsätzliche Nutzerfreigabe für Microsoft-Zugangsdaten, OneDrive-Schreibaktivierung, Krandorf-Anpassungen und Echtversand liegt inzwischen vor; sie ersetzt weder fehlende Microsoft-App-Rechte noch die Klärung widersprüchlicher Vertragsfassungen. Auch die Google-Vision-Bindings fehlen bislang im VermieterMe-Runtime. Ohne diese Schritte ist der vollständige Import → OCR → Buchung → Freigabe → Cloud-PDF → Versand-Abnahmelauf noch nicht durchgeführt. Für neue ChatGPT-Fachaktionen gegebenenfalls den Connector-Werkzeugkatalog aktualisieren; zusätzliche OAuth-Rechte müssen ausdrücklich autorisiert werden.

Bei späteren Releases immer Web und separaten Worker gemeinsam auf dasselbe geprüfte Image aktualisieren und diese Parität erneut bestätigen. Die tatsächlichen Swarm-Image-IDs sind maßgeblich; eine CapRover-Anzeige allein genügt nicht als Deploymentnachweis.

## Freigegebene Microsoft-Runtime-Aktivierung und Belegprüfung

Nach ausdrücklicher Freigabe wurden ausschließlich `Application_client_ID`, `Directory_tenant_ID` und `CLIENT_SECRET_VALUE` aus dem bestehenden MtBaCo-Portal serverseitig in die Docker-Swarm-Spezifikationen von Web und Worker übernommen. Werte wurden weder ausgegeben noch ins Repository übernommen. Vorher wurde `microsoft-activation-backup/` im privaten Releaseordner erstellt: 75 Tabellen, fünf Uploads und fünf referenzierte Originale; SQLite-Integrität, Fremdschlüssel und isolierte Upload-Wiederherstellung bestanden. Die vorherigen Service-Spezifikationen liegen dort mit Modus 0600.

Nach dem Neustart wurden beide tatsächlich laufenden Container geprüft: weiterhin dieselbe Image-ID wie oben, healthy, keine Neustarts, alle drei Runtime-Bindings vorhanden. Ein Token aus den tatsächlichen VermieterMe-Bindings wurde erfolgreich bezogen. Die bestehenden Graph-Anwendungsrollen sind ausschließlich Mail.ReadWrite, Mail.ReadBasic.All, Mail.Read, Mail.Send und Mail.ReadBasic. Die Abfrage der ausgewählten MtBaCo-Mailbox liefert HTTP 200. Der Nutzer hat einen konkreten privaten Testempfänger benannt; ein Testversand wurde noch nicht durchgeführt.

Der direkte Graph-Zugriff der App auf das OneDrive-Ziel liefert HTTP 403. Der vorhandene lesende rclone-Zugang bestätigt inzwischen den Ordner `Vermietung/` unter `VermieterMe`; die frühere Aussage eines leeren Zielordners gilt daher nur für die erste Deploymentprüfung. Der Nutzer hat anschließend ausdrücklich rclone für die Archivierung gewählt. Es werden keine zusätzlichen Entra-Dateirechte erteilt. Ein technischer Upload wurde unter `VermieterMe/_Abnahme_2026-10-09/Versandnachweis_Technischer_Test_2026-10-09.pdf` mit rclone unveränderlich abgelegt und vollständig heruntergeladen: 2287 Bytes, SHA-256 `bc0f0aeca039db0e0201ada8e3f494935eae5e4a526abe9d11d0ab9f852a00ee`. Der Nachweis liegt privat in `microsoft-activation-backup/rclone-write-probe.json`. Dies war zunächst ein Transporttest, kein Facharchivjob. Eine dedizierte Konfiguration wurde unter `/var/lib/vermieterme-rclone/rclone.conf` ausschließlich an den VermieterMe-Root gebunden; bestehende gemeinsame rclone-Integrationen bleiben unverändert.

Die vom Nutzer benannten lokalen Vertragsordner wurden geprüft. Alle zwölf Dateien im Schart-Unterordner einschließlich PDFs, editierbarer Word-Fassungen, binärer DOC-Datei, Excel-Liste und Bilder wurden gelesen. Der private ausführliche Prüfbericht liegt im Chat-Arbeitsbereich, nicht im Git-Repository. Gefunden wurden widersprüchliche Vertrags-/Abrechnungssummen und Unterschiede zwischen Oktober-Nachträgen und dem Umstellungsplan; unterzeichnete Oktober-Nachträge fehlen in den geprüften Pfaden. Strittige Finanzwerte wurden nicht produktiv geändert. Der Nutzer hat angewiesen, den Zähleraufkleber bei dieser Prüfung außer Betracht zu lassen.

Die Runtime-Bindings sind in den Swarm-Service-Spezifikationen persistent. Die CapRover-Appdefinition wurde bei dieser Übernahme nicht geändert. Ein späteres CapRover-Deployment muss die freigegebenen Bindings aus der aktuellen Service-Spezifikation ausdrücklich erhalten bzw. über die authentifizierte CapRover-Konfiguration übernehmen, sonst kann es sie entfernen. Direkte Image-Updates beider Dienste müssen deren aktuelle Env-Bindings erhalten.

Während der Prüfung war die VPS-Partition vorübergehend voll. Nachfolgend waren wieder etwa 3,5 GB verfügbar; diese Sitzung hat dafür keine fremden Ressourcen gelöscht. Web und Worker blieben erreichbar. Vollständige Cloud-/OCR-/Buchungs-/PDF-/Versand-Abnahme bleibt offen.

## Abschließende produktive rclone-Abnahme

Die ausdrücklich gewählte Archivumstellung wurde auf `main` implementiert, geprüft, committet und gepusht. Microsoft Graph bleibt für Mail und Import zuständig; zusätzliche Entra-Dateirechte wurden nicht erteilt. Beide Dienste verwenden die dedizierte private VermieterMe-rclone-Konfiguration, das unveränderte gemeinsame Datenvolume und alle bereits freigegebenen Microsoft-Runtime-Bindings.

- Git-Revision der Anwendung: `a2e9fd3062981631c89cf5ba55b18f15fd351730`.
- Image: `img-captain-vermieterme:19-rclone-a2e9fd3`.
- Image-ID beider tatsächlich laufenden Container: `sha256:b8c4f04bff037392f4fe8f3ec28eecb5100c5b3f5f70eb7cfbf4115efc9a201d`.
- Web und Worker: jeweils healthy, 1/1, keine Neustarts; öffentliche Health-Prüfung HTTP 200.
- Private Releaseablage: `/var/backups/vermieterme/releases/20261009-rclone-object-a2e9fd3`. `online-backup/`, `cutover-backup/` und die zusätzliche `classification-backup/` enthalten jeweils 75 Tabellen, sechs Uploads und sechs referenzierte Originaldateien. SQLite-Integrität, Fremdschlüssel und isolierte Wiederherstellung der Uploads bestanden.
- Alle 13 Migrationen sind angewendet. Es gibt keine neue Migration für den Archivtransport. Der Linux-Produktions-/Workerbuild und der Start mit isoliert wiederhergestellter Sicherung lieferten Health/Login HTTP 200.
- Lokal mit Node 22 und gepinntem pnpm: 168 Tests in 32 Dateien, sechs Playwright-Prüfungen, TypeScript und Schema-/Migrationsparität bestanden; Lint ohne Fehler mit zwei bestehenden Hook-Warnungen.

Die reale Prüfung deckte zwei rclone-Eigenheiten auf: ein Root-Stat kann ohne Cloudzugriff synthetisch erfolgreich sein, und direkte Datei-Wurzeln funktionieren mit diesem OneDrive-`root_folder_id` nicht zuverlässig. Die finale Implementierung prüft tatsächliche Cloud-Listings und benutzt `rc --loopback operations/stat|copyfile|movefile` mit getrenntem Root und literalem Objektpfad. Es läuft kein RC-Netzwerkserver. Die Konfiguration bleibt an genau einen Remote, Drive und Root gebunden; temporäre Kopien sind privat und werden aufgeräumt. Vollständiger Download, Größe und SHA-256 sind Pflicht. Ein realer technischer Upload-/Verschiebe-/Wiederholungsnachweis behielt dieselbe Cloud-Item-ID und erzeugte kein Duplikat.

Ein unbeschränkter Zwischenbuild belastete RAM/Swap und machte VPS/HTTP vorübergehend unresponsive. Der eigene Build wurde beendet; der Host erholte sich. Der erfolgreiche finale Build lief mit zwei CPUs, 2 GiB RAM, 3 GiB RAM/Swap und 1 GiB Node-Heap. Sein sauberer Git-Quellkontext enthielt keine Sicherungen, Service-Spezifikationen oder Secrets. Die Linux-Produktionsabhängigkeiten des vorherigen Images wurden nur nach Prüfung unveränderter Lockfiles, Prisma-Schema und Runtime-Eingaben wiederverwendet. Fremde Apps, gemeinsame rclone-Integrationen und deren Konfiguration wurden nicht geändert. Bei der abschließenden Prüfung waren etwa 5,4 GB Plattenplatz verfügbar.

### Echte Archivjobs und Originalerhaltung

Die Speicheraktivierung lief über benutzergebundene Vorschauen: zuerst deaktivierte Konfiguration, tatsächliche lesende Cloudprüfung, dann die ausdrücklich freigegebene Aktivierung. Der separate produktive Worker verarbeitete den technischen PDF-Beleg und fünf bestehende Heizöloriginale. Alle sechs Archivjobs sind DONE, alle sechs Archivdatensätze VERIFIED. Die technische PDF ist als `billing_preview` gespeichert und wird nicht erneut als Rechnung importiert. Eine Wiederholung ihres Jobs behielt dieselbe Datei-ID, dieselben 2287 Bytes und den SHA-256; genau ein Originaldatensatz existiert.

Die fünf Heizöl-PDFs wurden unabhängig gelesen und vollständig gerendert. Rechnungsdatum, Lieferant und Rechnungsnummer wurden direkt am Original geprüft. Ihre endgültigen Pfade verwenden das Rechnungsjahr:

- 2025: ein Original unter `Krandorf/2025/Rechnungen/Heizkosten/Heizoel/`.
- 2024: ein Original unter `Krandorf/2024/Rechnungen/Heizkosten/Heizoel/`.
- 2023: ein Original unter `Krandorf/2023/Rechnungen/Heizkosten/Heizoel/`.
- 2022: zwei Originale unter `Krandorf/2022/Rechnungen/Heizkosten/Heizoel/`.

Die Originale wurden aus dem Eingang verschoben. Alle ursprünglichen Cloud-Item-IDs, Bytes und Hashes blieben erhalten; alte Dateinamen und lokale Beleg-IDs wurden nicht geändert. Die bestätigte Archivklassifizierung ist auditiert. Es wurden keine CostInvoice-Duplikate, neuen Heizölbuchungen oder FIFO-Verbräuche erzeugt. Ein Verschiebejob meldete zunächst einen rclone-Fehler; vor seinem manuellen Retry wurden die Cloud-Datei, Zielpfad, stabile Item-ID und SHA-256 erfolgreich abgeglichen. Danach erledigte der Worker denselben deduplizierten Job. Der Fehler wird nicht als automatisch bestandener Lauf dargestellt.

Die abschließende private Prüfung `final-preservation.json` verglich 66 unveränderte Tabellen vollständig mit der Sicherung vor Stand 19, darunter Miet-/Finanzstammdaten, Heizöllieferungen, FIFO-Lots/-Verbräuche und alte BillingSnapshots. Alle sechs lokalen Uploadhashes und Originalmetadaten sind erhalten; ausschließlich verifizierter Hash und Objektzuordnung der alten Belege wurden ergänzt. Erwartete Änderungen betreffen Periodenteilung, Archiv-/Jobzustände, Vorschauen/Audits, Prüfhinweise und die normale MCP-Tokenrotation. Integrität/Fremdschlüssel sind fehlerfrei.

### Periodenteilung, Connector und Browser

Die offene Restperiode `billing-transition-rest-2026` wurde über die fachliche Vorschau/Commit-Aktion in 13.–30.09.2026 und 01.10.–31.12.2026 geteilt. Die alte ID bleibt mit SUPERSEDED erhalten. Neue IDs sind `cmv0xtkqq000277xy4aoezovx` und `cmv0xtkqr000477xy6ue5clnl`. Der zweite Commit derselben Vorschau gab das bereits gespeicherte Ergebnis zurück. Die historische Sonderperiode bleibt erhalten; drei aktive Zeiträume überlappen nicht. Strittige Oktober-Finanzwerte und Verteilungsregeln wurden nicht geändert.

Der echte ChatGPT-Connector liest die aktivierte DocumentStorage-Konfiguration, die sechs VERIFIED-Archive und die sechs erledigten Archivjobs. Der angemeldete Webworkflow zeigt die neuen Zeiträume, aktivierte OneDrive-Ablage und die geprüften Jahrespfade. Die Prüfung der Oktoberperiode blockiert korrekt wegen fehlender aktiver Kostenarten und unvollständiger/veralteter Berechnungen. Es gibt weiterhin null produktive StatementRevision-Zeilen.

### Verbleibende Voraussetzungen

Die generelle Freigabe für Microsoft, Cloud-Schreiben, Krandorf und Echtversand liegt vor. Offen bleiben die verbindliche Auflösung der widersprüchlichen Oktober-Vertrags-/Regelfassungen, deren Nachweise, vollständige Kosten-/Messdaten, explizite Auswahl und Prüfung einer Importquelle sowie die separat zu autorisierenden Google-Vision-Runtime-Bindings. Der neue Fachwerkzeugkatalog muss im ChatGPT-Connector verfügbar sein; passende OAuth-Rechte sind gesondert erforderlich. Die konkrete technische Testmail mit benanntem Empfänger und vorliegender PDF-Vorschau wartet auf Text-/PDF-Bestätigung. Kein Echtversand wurde ausgelöst. Der vollständige reale Import → OCR → Buchung → zwei NKA-PDFs → Freigabe → R002-/R001-Erhaltung → Versand-Lauf steht weiterhin aus.

Private Einzelbeleg-, Backup-, Deployment-, Transport-, Perioden- und Erhaltungsnachweise bleiben auf dem VPS bzw. im privaten Chat-Arbeitsbereich. Die Images 17, 18 und 19 sowie Sicherungen bleiben erhalten. Stand 18 enthält den inzwischen behobenen direkten rclone-Dateizugriffsfehler und ist deshalb kein funktionaler Archiv-Rollback. Für einen vollständigen Rollback beide Dienste anhalten und passende Datenbank/Uploads gemeinsam prüfen und wiederherstellen; keine Historie oder Originale zurücksetzen, ohne die inzwischen vorgenommenen Archiv-/Periodenänderungen abzugleichen.

## Nachfolgende Abnahme: neueste Vertragsquellen und Rechnung 60954

Die spätere ausdrückliche Nutzerentscheidung „take the latest contracts as source / if in doubt“ löst den zuvor beschriebenen Quellenkonflikt auf. Die bereits erteilte Freigabe produktiver Krandorf-Anpassungen wurde mit diesen konkreten Quellen umgesetzt. Die Unterschriftsfelder beider DOCX-Nachträge sind leer; sie werden als ausgewählte Quellen gespeichert und nicht als unterzeichnet bezeichnet. Es entstand keine neue ausgestellte Abrechnung.

- Anwendungscode `932f77370e48e2678dcfef24253f31a10af2febc`, normal auf `origin/main` gepusht; keine Branch-/Worktree-Erstellung.
- Web und Worker: `img-captain-vermieterme:20-contracts-932f773`, tatsächlich dieselbe Image-ID `sha256:e146d154081d72008b788fe2792b7093e9d829133c9a8a96078c167355b53e57`, jeweils 1/1 healthy, null Neustarts. Microsoft-Bindings und dedizierte rclone-Mounts sind unverändert erhalten.
- Private Releaseablage `/var/backups/vermieterme/releases/20261009-latest-contracts`, mit geprüften `online-backup`, `cutover-backup` und `latest-source-backup`: jeweils 75 Tabellen, sechs bisherige Uploads und sechs Referenzen. Isolierter Start mit wiederhergestellter DB/Uploads, ohne Microsoft-Secrets oder Worker: Health/Login HTTP 200.
- Begrenzter Build: zwei CPUs, 2 GiB RAM, 3 GiB RAM/Swap, 1 GiB Node-Heap. Erster Versuch scheiterte vor dem Build an pnpm ohne CI-Variable; nach `CI=true` Linux-Produktions-/Workerbuild erfolgreich. Keine neue Migration; alle 13 angewendet, Produktions-Migrationsparität ohne Unterschied. Lockfile, Schema und Runtime-Abhängigkeiten unverändert.
- Lokal Node 22/gepinntes pnpm: 171 Tests in 32 Dateien, sechs Playwright-Prüfungen, Lint, TypeScript und Produktionsbuild bestanden. Zwei bestehende Hook-Warnungen bleiben. Neue Prüfungen decken DOCX-Originalerhaltung/Deduplizierung und Rechnungsimport-Ausschluss sowie gemessene Stromgrundpreis-Verteilung einschließlich fehlender Grenzablesung ab.

### Quellen und produktive Änderungen

Schart: `Nachtrag_Mietvertrag_Isabella_Schart_ab_2026-10-01.docx`, 42353 Bytes, SHA-256 `759450b655bbc4dd5cf8487b76887bd94cceef13aae2c76a5c26f1a3258045d8`, Document-ID `cmv172fhb0001uimzis5y96is`. Janca: `Nachtrag_Mietvertrag_Vladimir_Janca_ab_2026-10-01.docx`, 42200 Bytes, SHA-256 `0534b59302f3c9d0f2f95f505556390763990d3b0bbd7c9cc419ba219bb00478`, Document-ID `cmv172fkq000buimzdafbgrvs`. Beide Originale liegen unter `Krandorf/Vertraege_und_Stammdaten/` mit ihrer Beleg-ID und Originalformat DOCX.

20 individuelle Vorschau-/Commit-Aktionen wurden unter dem echten Admin-Auditprinzipal mit der ausdrücklichen Quellenauswahl als Grund ausgeführt; jede zweite Commit-Ausführung derselben Vorschau lieferte dasselbe Ergebnis. Schart: 288/175/41 Euro ab Oktober, monatlich 504 Euro statt der bisherigen 521 Euro. Janca: 360/380/90 Euro, monatlich 830 Euro statt 750 Euro. Die alten Finanzzeilen behalten alle bisherigen Beträge und Quellen; ausschließlich `validTo` wurde auf 30.09.2026 gesetzt. Zahlungsbuchungen/Rückstände wurden nicht verändert.

Fünf datierte Regeln wurden angelegt: Müll, Kleinkläranlagenbetrieb und Anlagenstrom je Drittel für zwei Mietwohnungen plus Eigentümer; Stromgrundpreis gemäß §4 nach gemessenem Stromverbrauch der zwei versorgten Mietwohnungen; Heizkosten nach Standard-Heizkostenmodus, bestehendem 50%-Verbrauchsanteil und Grundkostenflächen 80/280 sowie 200/280, Eigentümerwohnung ausgeschlossen. Acht Kostenvereinbarungen verweisen auf den jeweiligen Mietnachtrag. Die vier Oktober-Kostenarten wurden aktiviert. Wasser bleibt für die ursprüngliche Vertragsgrundlage gesondert zu prüfen; Grundsteuer ohne Bescheid/Mietwohnanteil wurde nicht konfiguriert. Fehlende Messwerte oder Bestände wurden nicht ergänzt.

### Neues Heizöloriginal und Erhaltungsprüfung

Die unabhängig visuell geprüfte zweitseitige Rechnung 60954 vom 06.10.2026 hat 756314 Bytes und SHA-256 `5029f312949bef035966460b91e457b65ca0b1be2aab46b9cc58a8bfbc1f0a26`. Document-ID `cmv172fmy000luimz9efzk5ka`, Invoice-ID `cmv172fp0000uuimz7j4c9dez`, Status DRAFT ohne Periodenbindung. Geprüfte Entwurfswerte: 2.002 Liter, netto 2.906,74 Euro, MwSt. 552,28 Euro, brutto 3.459,02 Euro, CO₂-Kosten inkl. MwSt. 382,56 Euro. Die 2.000 Liter auf dem Lieferschein sind ausdrücklich „Bestellmenge ca.“; Messausdruck und Rechnung nennen 2.002 Liter. Es wurde kein Mengenkonflikt konstruiert und keine Liefer-/FIFO-Buchung angelegt.

Der Worker archivierte die drei neuen Originale und verschob die Rechnung nach der getrennt auditierten Archivklassifizierung nach `Krandorf/2026/Rechnungen/Heizkosten/Heizoel/2026-10-06_Mineraloele_Oberpfalz_GmbH_60954__cmv172fmy000luimz9efzk5ka.pdf`. Ihre Cloud-Item-ID `01342T7C7CQMUPZB5QWZHZGD2CXQDKB4R3` blieb erhalten. Alle neun Archive sind VERIFIED und neun Archivjobs DONE. Ein zusätzlicher vollständiger Cloud-Readback prüfte bei allen neun Originalen Größe, SHA-256 und dieselbe Item-ID am endgültigen Pfad; diese Prüfung erzeugte keine Kopien.

`final-preservation.json` vergleicht 59 unveränderte Tabellen vollständig, darunter alte Snapshots, Heizöllieferungen, FIFO-Lots/-Verbräuche und Zahlungsdaten. Alle sechs vorherigen lokalen Originalbytes/-metadaten sowie ihre Archivdatensätze sind unverändert. Finanzhistorie änderte ausschließlich die zwei Enddaten; insgesamt bestehen vier Finanzzeilen. SQLite-Integrität/Fremdschlüssel, neun eindeutige Originalhashes, null StatementRevision-Zeilen und öffentliche Health HTTP 200 sind geprüft. Der echte ChatGPT-Connector zeigt vier Finanzzeilen mit den ausgewählten Quellen und die neuen Archive. Der angemeldete Webworkflow zeigt die Oktoberperiode, neun geprüfte Archive und die weiterhin blockierte Abrechnungsprüfung.

### Noch offener vollständiger Abnahmelauf

Reale Strom-/Heizkosten-Vorschauen wurden zusätzlich direkt über dieselben Fachmodule geprüft: Stromgrenzablesungen am 01.10. und 31.12. für beide Mietzähler fehlen. Genau ein aktiver Heizöltank ist auszuwählen; erforderliche Tankbestände und Wärmegrenzablesungen fehlen. Die Abrechnung bleibt zudem wegen ungeprüfter Rechnung und fehlender vollständiger Kostenberechnungen gesperrt. Keine Nullkosten, Verbrauchswerte oder steuerlichen Mietwohnanteile wurden erfunden. Die getrennte konkrete Testmail-/PDF-Bestätigung und Tankklärung wurden dem Nutzer vorgelegt; noch kein Echtversand ausgelöst.

Importquellenauswahl/-prüfung, autorisierte Google-Vision-Bindings, der aktualisierte ChatGPT-Fachwerkzeugkatalog mit passenden OAuth-Rechten und reale Mess-/Kosten-/Grundsteuernachweise bleiben Voraussetzungen. Die 23 derzeit in diesem Chat geladenen Connectorwerkzeuge enthalten die neuen Domain-/Freigabeaktionen noch nicht; der erfolgreiche Admin-Fachablauf wird nicht als ChatGPT-Schreibabnahme ausgegeben. Vollständiger Import → OCR → Buchung → zwei NKA-PDFs → Freigabe → R002 mit unverändertem R001 → Versand steht weiterhin aus. Stand 19 und geprüfte Backups bleiben erhalten; ein Datenrollback muss die jetzt vorhandenen drei neuen Originale und Oktobervereinbarungen berücksichtigen.
