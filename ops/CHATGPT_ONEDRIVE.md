# ChatGPT-Abwicklung und OneDrive-Betrieb

## Stand und Freigabegrenze

Die Implementierung ist in `main` committet und gepusht. Nach ausdrücklicher Bestätigung wurden am 09.10.2026 Backup, Migration und Web-/Worker-Deployment abgeschlossen. Die lesende Abnahme über den echten ChatGPT-Connector und den angemeldeten Browser ist bestanden. Details und Rollbacknachweise stehen in [der Deployment-Abnahme](releases/2026-10-09-chatgpt-onedrive.md). Die vollständige Microsoft-Import-/Cloud-/Versandabnahme gehört zur separat bestätigten Einführung.

Web und Worker verwenden dasselbe Image und Datenvolume. Microsoft-Mail-Zugangsdaten wurden nach ausdrücklicher Freigabe serverseitig übernommen; Tokenbezug und Zugriff auf das ausgewählte Postfach sind geprüft. Microsoft Graph bleibt für Mail zuständig. Die App besitzt keine OneDrive-Dateirechte; diese werden für die Archivierung nicht erweitert.

Der Nutzer hat rclone für die OneDrive-Archivierung gewählt. Der Windows-Synchronisationsordner ist `E:\OneDrive - Mount Batur Consulting GmbH\VermieterMe`. Die aktuelle Cloudprüfung findet Vertragsunterlagen und Wasserrechnungen; der Ordner ist inzwischen befüllt. Das geprüfte Ziel:

- Drive-ID: `b!lNKDCX71D0ihHVxiDQFcMex82vha131CiKr2ahQ4z4BDA2ikM6J4SLAiPT8Lvbuk`
- Root-Item-ID für `VermieterMe`: `01342T7C5PC7DT735KRZAZIBB645KOHBX5`
- Dedizierter Remote: `VermieterMe-Archive`, ausschließlich auf diesen Root gebunden. Ein technischer PDF-Upload unter `_Abnahme_2026-10-09` wurde vollständig heruntergeladen und mit SHA-256 geprüft. Er ersetzt noch keinen Fachjob oder vollständigen Abrechnungslauf.

## rclone-Runtime

`ONEDRIVE_ARCHIVE_BACKEND=rclone` wählt den gemeinsamen Archivtransport; ohne diese Einstellung bleibt Graph der Standard. Persistente Archivjobs, Vorschaufreigaben und Revisionen verwenden denselben Fachablauf. Mail und OneDrive-Importquellen bleiben Graph-basiert; die Archivumstellung aktiviert keine Importquelle.

Web und Worker benötigen den auf dem VPS vorhandenen statischen rclone 1.73.1 als schreibgeschützten Bind-Mount `/usr/bin/rclone:/usr/local/bin/rclone`. Das private Verzeichnis `/var/lib/vermieterme-rclone` wird nach `/run/vermieterme-rclone` eingebunden. Es gehört UID/GID 1001 mit Modus 0700; seine einzige Konfiguration `rclone.conf` hat Modus 0600. Das Verzeichnis ist für die Token-Erneuerung schreibbar. Die bestehende gemeinsame OneDrive-Konfiguration bleibt unverändert und wird nicht in die Anwendung eingebunden.

Runtime-Einstellungen: `RCLONE_BINARY`, `RCLONE_ARCHIVE_CONFIG`, `RCLONE_ARCHIVE_REMOTE`, `RCLONE_ARCHIVE_DRIVE_ID`, `RCLONE_ARCHIVE_ROOT_ID` und `RCLONE_ARCHIVE_FOLDER_PATH=VermieterMe`. `.env.example` beschreibt die Werte ohne Zugangsdaten. Config-Inhalt und Cloud-Fehlerausgaben dürfen nicht geloggt werden. Zusätzliche rclone-Umgebungsoptionen werden beim Kindprozess entfernt.

Vor Zugriff prüft der Adapter den einzelnen Remote sowie die tatsächlichen Drive-/Root-Bindings in der privaten Konfiguration. Ein rclone-Root-Stat kann ohne Item-ID zurückkommen; die genaue Konfigurationsbindung und eine tatsächliche Cloud-Verzeichnisabfrage bleiben deshalb Pflicht. Objektzugriffe benutzen `rclone rc --loopback` mit getrennten Root-/Objektpfaden und unveränderlicher Konfiguration; dabei wird kein RC-Netzwerkserver gestartet. Direkte Dateiwurzeln funktionieren mit dem geprüften OneDrive-`root_folder_id` nicht zuverlässig. Jede Mutation prüft Ziel und Originalbytes. Uploads und Verschiebungen sind unveränderlich, Wiederholungen lesen vorhandene Bytes zurück. Belegte Zielpfade mit abweichendem Inhalt oder anderer Item-ID blockieren. Verifikation verlangt vollständigen Download, Größe und SHA-256. Runtime-Bindungswechsel machen eine frühere Speicherprüfung ungültig; danach erneut `test_document_storage` ausführen.

## Gemeinsame Fachmodule und Bedienung

- `domain-changes`: datierte Verwaltung, Vertragsparteien, Mietwechsel, Flächen/Eigentümernutzung, Finanzvereinbarungen, Kostenarten/-regeln, Stromverträge/-tarife, Zähler, Wärmemessung, Tank/Anfangsbestand, Nachweise und Integrationskonfiguration.
- `configured-allocation`: gemeinsamer Resolver für Fläche, gleiche/individuelle Gewichte, Verbrauch und gemischte Grund-/Verbrauchskosten. Regeln, Zustände und Verbrauchswechsel erzeugen getrennte Zeitabschnitte; Centbeträge bleiben erhalten.
- `billing-workflow`: Arbeitsübersicht, Fachprüfung, unveränderliche PDFs, Freigabe, Korrektur und geprüfte Versandvorschau. Die Weboberfläche `/workflow` und MCP benutzen dieselben Funktionen.
- `document-intake` / `document-archive`: Originalbytes, SHA-256, Upload-/Ablagejobs und Größen-/Hashnachweis.
- `microsoft-import` / `background-jobs`: ausgewählte Delta-Quellen, Wiederanlauf, Outbox und geänderte Prüfprobleme. Der bestehende separate Worker führt diese Jobs aus.

MCP-Abfolge: `billing_workspace` → `describe_domain_actions` → `preview_domain_change` → ausdrückliche Prüfung → `commit_domain_change`. Finanzvorschauen zeigen alte/neue monatliche Gesamtsummen und vereinbarte Vorauszahlungen der betroffenen Zeiträume. Andere Änderungen benennen betroffene Entwürfe; die anschließende Berechnung liefert die tatsächlichen Kostenwirkungen.

Vorschauen sind benutzergebunden und laufen nach fünf Minuten ab; Abrechnungs-/Versandfreigaben nach 30 Minuten. Geänderte Grundlagen werden abgewiesen. Wiederholte bestätigte Aufrufe geben das bereits gespeicherte Ergebnis zurück. Historie, Snapshots, ausgestellte Abrechnungen, Verbrauch und Audits sind über generisches CRUD gesperrt. Korrekturen benutzen die fachlichen Revisionsaktionen.

OAuth trennt `vermieterme:read`, `vermieterme:write`, `vermieterme:approve` und `vermieterme:admin`. Eine Anmeldung erteilt diese Rechte nicht automatisch. Die Autorisierungsseite zeigt die angeforderten Rechte; fehlende Rechte liefern eine MCP-OAuth-Challenge für erneute Zustimmung. Abrechnungsfreigabe und Versand verlangen zusätzlich die konkrete bestätigte Vorschau.

## Ablage und Revisionen

Rechnungen liegen unter `<Objekt>/<Rechnungsjahr>/Rechnungen/<Kostenart>`. Das Leistungsjahr verändert diesen Ort nicht. Die bekannten Kategorien folgen dem vereinbarten Krandorf-Baum einschließlich Heizöl, Wartung, Schornsteinfeger sowie Kleinkläranlagen-Wartung und Betriebsstrom. Weitere Kategorien erhalten normalisierte Namen und IDs. Die Kombination aus gespeichertem Objektziel, Beleg-/Kostenart-/Mietverhältnis-IDs und Datenbank-Eindeutigkeitsregeln verhindert Kollisionen.

Ungeprüfte Originale liegen in `Eingang/Ungeprueft`; bestätigte Verträge in `Vertraege_und_Stammdaten`. Nach der Klassifizierung wird ein Original aus dem Eingang an seinen endgültigen Rechnungsort verschoben. Ein dort archivierter Beleg wird bei weiteren Abrechnungen oder Rechnungsrevisionen nicht automatisch nochmals abgelegt. Dateien behalten ihr Originalformat und ihre exakten Bytes; ursprünglicher Name und Hash bleiben gespeichert. Fehlendes Rechnungsdatum verhindert die endgültige Jahreszuordnung.

Abrechnungen liegen unter `<Objekt>/<Periodenendjahr>/Nebenkostenabrechnungen/<Start>_bis_<Ende>/Entwuerfe|Freigegeben/<Name>__<Mietverhältnis-ID>`. Jede erzeugte PDF-Vorschau trägt eine eigene ID. Die Freigabe verschiebt genau diese geprüften Bytes an `R001.pdf`. Erst nach nachgewiesener endgültiger Ablage entstehen die ausgestellten Statement-Revisionszeilen. Ein Uploadfehler blockiert die Ausstellung; `ARCHIVING` verlangt später einen erneuten Aufruf derselben Freigabe.

Eine abgelaufene offene Freigabe kann mit `renew_billing_approval` für dieselben PDFs neu geprüft werden, solange die Grundlagen unverändert sind. Bereits zur endgültigen Ablage vorbereitete Fassungen werden nicht durch neue Vorschauen überschrieben. Bei zwischenzeitlich geänderten Grundlagen ist eine gezielte Prüfung des vorbereiteten Archivstands erforderlich.

`revise_billing_period` erzeugt den Korrekturzeitraum; erneute Berechnung/Freigabe erzeugt `R002` mit Verweis auf `R001`. Alte Snapshots und PDFs bleiben erhalten. Administrator- und Mieter-Einzel-PDF-Endpunkte liefern bei neuen ausgestellten Fassungen die gespeicherten Originalbytes. Historische Fassungen ohne PDF-Artefakt behalten ihren bisherigen Snapshot-Export. Ein Sammel-PDF ist ein zusätzlicher Export, keine neue ausgestellte Einzelrevision.

Das Belegverzeichnis gehört zum eingefrorenen Statement und steht im PDF. Originalbelege werden über hashgeprüfte, zehn Minuten gültige Links angezeigt. Versandauftrag, Microsoft-ID, Status und Annahmezeitpunkt beziehen sich auf das PDF-Artefakt und damit auf dessen Revision. Versand ändert weder PDF noch Archivpfad. Eigene Abrechnungen und Archivexporte sind vom Rechnungsimport ausgeschlossen.

## Rechnungen und automatisierte OCR

Rechnungen sind unabhängig von Abrechnungsperioden gespeichert. Buchung prüft Datum, Leistungszeitraum, Positionen, Summen/Steuerdaten, Umlagefähigkeit und Dubletten. Nicht umlagefähige Positionen bleiben als Beleginhalt erhalten. Manuelle Betriebskosten verbuchen ihren periodischen Quellenanteil im Invoice-Consumption-Ledger; Heizölverbrauch wird über das separate FIFO-Lot-Ledger nachgewiesen. Stromjahresrechnungen/Tarifbelege dienen der Prüfung der gemessenen Tarifberechnung und werden nicht zusätzlich als volle Kosten verrechnet.

OCR-Vorlagen werden als Entwurf erstellt. Sollwerte müssen ausdrücklich am Original gelesen und über `confirm_invoice_sample` mit Vorschaufreigabe bestätigt werden. Zwei unterschiedliche TRAINING-Originale und mindestens ein HOLDOUT-Original sind Pflicht. Erst erfolgreiche Regressionstests veröffentlichen die Vorlage automatisch. Aus einer OCR-Antwort werden keine Sollwerte erzeugt.

Automatische Buchung erfordert eine aktivierte Quelle mit `autoBook`, genau einen passenden veröffentlichten Vorlagensatz, dessen aktuelle unabhängige Testnachweise und vollständig bestandene Rechnungsprüfung. Unklare Zuordnungen, nicht umlagefähige Positionen sowie benötigte Vertrags-/Tarif-/Tank-/Grundsteuer-Nachweise erzeugen einen Prüfauftrag. Eine OCR-Vorlage bestätigt solche Stammdaten nicht selbst. Automatische Buchungen verwenden einen eigenen nicht anmeldbaren Audit-Prinzipal und schreiben Buchung und Audit in derselben Datenbanktransaktion.

## Energie und Krandorf

Stromgrundpreis wird über eine eigene BASE-Regel unabhängig von Verbrauchszählern verteilt. Tariflücken, fehlende Grenzablesungen und unbelegte Schätzungen blockieren die Freigabe. Heizöl wird anhand bestätigtem Anfangs-/Endbestand und FIFO inklusive Nebenkosten/CO₂ bewertet. OilFox liefert Bestandsdaten und ersetzt keine Wärmeverbrauchsmessung.

Standard-Heizkosten benötigen bestätigte Wärmezählerstände an Perioden- und Mietergrenzen und einen zulässigen Verbrauchskostenanteil. Flächen-Grundkosten und gemessene Verbrauchskosten werden getrennt verteilt. Unbelegte Ausnahmen, fehlende Messdaten und derzeit nicht unterstützte zentrale Warmwasserabrechnung bleiben Freigabesperren.

Vereinbarte Betriebs-/Heizkostenvorauszahlungen werden gemeinsam einmal angerechnet; Stromvorauszahlungen erscheinen separat. Zahlungsrückstände verändern diese Sollvereinbarung nicht. Pauschalen dürfen nicht zusätzlich als Vorauszahlung oder doppelte Kosten angerechnet werden.

`prepare_krandorf_transition` bereitet ab 01.10.2026 atomar Wasser nach 80/390, 200/390, 110/390 und Müll/Kleinkläranlage/Stromgrundpreis zu gleichen Dritteln vor. Es verlangt eindeutig passende Einheiten, einen Regelschlüssel-Nachweis und je Mietverhältnis einen Vertragsnachweis. Isabella erhält 288/187/41 Euro, Vladimir 360/410/90 Euro; frühere offene Finanzzeilen werden zum 30.09. geschlossen. Optional wird der noch nicht ausgestellte Restzeitraum am 01.10. geteilt. Vorhandene kollidierende Oktober-Regeln werden nicht überschrieben, sondern müssen ausdrücklich revidiert werden.

Grundsteuer wird separat mit belegtem Mietwohnanteil bestätigt. Historische Sonderzeiträume verlangen einen eigenen Nachweis; aktive überlappende Zeiträume werden abgewiesen. Unbekannte historische Flächen-/Nutzungsgültigkeit wird nicht erfunden.

## Microsoft-Einführung nach gesonderter Bestätigung

1. Den konkreten Deployment-Stand, Migration, Web-/Worker-Konfiguration und gewünschten produktiven Datenumfang vorlegen. Cloudprüfung darf zunächst ausschließlich lesend erfolgen. Kein Push/Deployment aus einer bloßen lokalen Implementierungsfreigabe ableiten.
2. SQLite inklusive konsistenter Sicherung und `data/uploads` sichern; Hashmanifest und isolierte Wiederherstellung prüfen. Version-4-JSON ergänzt Metadaten einschließlich Audit-Prinzipalen/-Ereignissen, enthält aber keine Uploadbytes, Passwörter, OAuth-Tokens oder Runtime-Secrets. Ältere Metadatensicherungen zunächst isoliert migrieren. Eine Wiederherstellung mit aktiven Quellen/Outbox nur im isolierten System ohne Worker und ohne Microsoft-Zugang durchführen.
3. Migrationen mit `prisma migrate deploy` anwenden, niemals produktives `db push`. Bestehende IDs und historische Originale bleiben erhalten. Unbestätigte historische HeatMeterReadings werden nicht automatisch als bestätigte Messung umgedeutet.
4. Nach ausdrücklicher Bestätigung die vorhandene MtBaCo-App über `Application_client_ID`, `Directory_tenant_ID`, `CLIENT_SECRET_VALUE` als Runtime-Secrets in Web und Worker bereitstellen. Kein Secret in Chat, Git, Export oder Logs. Passende Graph-Anwendungsrechte und den konkreten Mailbox-/Drive-Zugriff prüfen; App-Rechte nicht stillschweigend erweitern.
5. Bei rclone zuerst die dedizierte Runtime-Konfiguration und beide Bind-Mounts prüfen. `resolve_onedrive_target` mit Cloudordner `VermieterMe` ausführen; Inhalt, Drive-ID und Root-ID prüfen. Ziel per `configure_document_storage` zunächst deaktiviert speichern; `test_document_storage` liest den gewählten Ordner. Erst bestätigtes Aktivieren erlaubt Uploadjobs; die tatsächliche Schreibfähigkeit wird durch den ersten explizit erlaubten, vollständig hashgeprüften Upload nachgewiesen.
6. Mail-/OneDrive-Quellen mit konkreter Mailbox/Drive-ID, Folder-ID, Kostenart und Abschnitt zunächst deaktiviert speichern. `test_microsoft_source` ausführen. Erst nach bestätigter Prüfung aktivieren; Standardintervall 15 Minuten. Bereits vorhandene Originale gezielt mit `queue_property_originals` einplanen und jeden Fehler prüfen.
7. Web und separaten Worker mit identischem Datenvolume/Image starten; Image, Replikat 1/1, Health und echten API-/Browserpfad prüfen. Microsoft-Quellen und Krandorf-Daten sind gesonderte aktivierte Änderungen, keine automatische Folge der Migration.
8. ChatGPT erneut mit den ausdrücklich benötigten Scopes autorisieren. Einen realen Beleg importieren, Regeln unabhängig prüfen, Rechnung buchen, Änderungsvorschau bestätigen, alle Kosten berechnen, zwei PDFs lesen, Archivstatus prüfen und exakt diese Fassung freigeben. R002 erzeugen und R001-Hashes erneut vergleichen.
9. Empfänger, Text und genaue PDF-Vorschau bestätigen. Echtversand ausschließlich an einen ausdrücklich genannten Testempfänger. Microsoft 202 bedeutet angenommen, nicht zugestellt. Unklare Antworten über gespeicherte Immutable-ID abgleichen; niemals blind erneut senden.

## Fehlerbehandlung und lokale Abnahme

Temporäre rclone-Fehler werden höchstens fünfmal über persistente Jobs wiederholt; unveränderliche Uploads werden vor Wiederholung geprüft. 429/5xx-Graph-Import-/Archivfehler werden begrenzt mit Retry-After/backoff wiederholt. Ein verlorener Delta-Cursor löst eine sichere erneute Suche mit gespeicherten Source-IDs/Hashes aus. Lease-Übernahme und deduplizierte Jobs verhindern Doppelbuchungen. Geänderte Quellbytes verlangen Rechnungsrevisionen; reine Metadatenänderungen mit unveränderten Bytes erzeugen keinen neuen Beleg.

Outboxzustände PENDING, DRAFT_READY, UNCERTAIN und ACCEPTED sind dauerhaft gespeichert. Vor dem Sendaufruf wird UNCERTAIN gespeichert. Ein unklarer Draft wird periodisch lesend abgeglichen und nicht automatisch erneut gesendet. Bleibt Microsoft bei Draft/404, ist die gesendete Nachricht vor einem manuellen weiteren Auftrag zu prüfen.

Prüfprobleme werden als eindeutige Notices gespeichert; unveränderte Probleme erzeugen keine neuen Meldungen. Erledigte Probleme werden geschlossen. Externe Nachrichten an Personen werden dadurch nicht automatisch verschickt.

Lokale Prüfungen mit Node 22 und dem gepinnten pnpm: `corepack pnpm test`, `corepack pnpm lint`, `corepack pnpm exec tsc --noEmit`, `corepack pnpm exec prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --exit-code`, `corepack pnpm build:worker`, `corepack pnpm test:e2e`. Playwright baut die Produktionsanwendung und setzt ausschließlich `prisma/e2e.db` zurück. Graph-Fehler und Versand sind lokal simuliert; die Browserprüfung simuliert Cloud-Verifikationsantworten, während Integrationstests die echte Upload-/Move-/Outbox-Implementierung gegen einen kontrollierten Graph-Transport ausführen.

DOCX und Google-Connectoren sind zurückgestellt. Die vorhandene OCR nutzt weiterhin Google Vision über bereits konfigurierte Runtime-Secrets.

Lokales Abnahmeergebnis am 09.10.2026: 32 Testdateien mit 168 erfolgreichen Tests, sechs erfolgreiche Playwright-Prüfungen inklusive Produktions- und Workerbuild, TypeScript ohne Fehler und Schema-/Migrationsparität ohne Differenz. Lint hat keine Fehler und zwei bereits vorhandene Hook-Warnungen. Beide erzeugten Testabrechnungen wurden vollständig gerendert und auf Seitenumbrüche, Vorzeichen und Lesbarkeit geprüft. Der Korrekturlauf erhält die R001-Bytes und -Hashes unverändert. Diese lokale Abnahme ersetzt nicht den noch ausstehenden realen ChatGPT-/Microsoft-Lauf.
