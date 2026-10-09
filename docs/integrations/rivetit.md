---
label: RivetIT & RivetMSP
icon: plug
description: Sync clients, assets and contacts from a RivetIT or RivetMSP install into RivetDocs.
---

# RivetIT & RivetMSP Integration

RivetDocs is the documentation companion to the **RivetIT** and **RivetMSP** editions. Both editions expose the same read API (`/api/v1/clients`, `/assets`, `/contacts`), so one driver serves both. Pick **RivetIT** or **RivetMSP** in the integration gallery. You can connect both, each as its own integration.

## Overview & Features

- **Client-to-Company Mapping**: each edition client is a source organisation you map to a RivetDocs company.
- **Assets and Contacts**: two independent resources, each projected into its own asset layout.
- **Read-only**: RivetDocs never writes back to the edition.
- **No passwords**: credentials are not synced. The edition denies its legacy API key on `/credentials` by design, and RivetDocs keeps its own encrypted vault.

## Connecting

1. In the edition, create an instance API key (Admin > API).
2. In RivetDocs, go to Admin > Integrations, add **RivetIT** or **RivetMSP**, and enter:
   - **Instance URL**, for example `https://itflow.example.com`
   - **API Key**
3. Run **Test connection**, then **List source organisations** and map each client to a company.

The instance URL must be reachable from the RivetDocs API and worker containers. RivetDocs' outbound request guard blocks private and loopback addresses, so a LAN-only edition needs to be reached through its public hostname or a reverse proxy.

## Synced Data Reference

| Resource     | Fields                                                                        |
| ------------ | ----------------------------------------------------------------------------- |
| **Assets**   | Name, Type, Make, Model, Serial number, Operating system, Status, Client name |
| **Contacts** | Name, Title, Email, Phone, Extension, Client name                             |

Records are matched on the edition's numeric ID, so renaming an asset or contact in the edition updates the same RivetDocs record.
