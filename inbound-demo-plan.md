# Inbound Demo Flow

Distru inbound demo works like this:

A prospect submits the HubSpot demo form. The submission is rerouted as a POST to n8n, which runs an instant ICP check. If it passes inside 1.5s, we offer the demo right on the form and route it. If it fails or the check times out, the record goes to HubSpot for the fuller ICP checks and routing there instead.

## Fast path — n8n, 1.5s budget

The HubSpot form reroute POSTs to an n8n webhook and waits at most 1.5s. n8n scores the form fields against ICP. A pass means the form swaps to an instant booking offer. Ownership decides the rep: an account already owned by an AE routes to that owner, an unowned one goes to the next AE in the round robin.

## Slow path — HubSpot

A fail, or a timeout at 1.5s, drops the submission into HubSpot. HubSpot runs the deeper ICP checks with enrichment the form does not have, and does its own routing. A prospect that does not pass goes to nurture. One that passes gets the same ownership rule — existing owner kept, unowned round-robined — then enrolls in a sequence offering a demo or qualifying them first.

## Deal creation

Whichever path qualified them, a parallel workflow fires once a rep is assigned: it creates the deal and assigns it to that same rep. It never picks its own owner — it reads the assignment the routing step already made.

## Decision points

| Step | Runs in | Passes when | Fails to |
| --- | --- | --- | --- |
| Instant ICP check | n8n | ICP match returned < 1.5s | HubSpot slow path |
| Timeout | Form reroute | — | HubSpot slow path |
| HubSpot ICP check | HubSpot | Enriched ICP match | Nurture |
| Ownership | Both | Account has an AE owner | Round robin |

## Open questions

- What is the round-robin pool — all AEs, or segment/territory-scoped?
- Does the fast path also write to HubSpot, or does n8n own that record until the deal is created?
- What counts as "owned" — an open deal, any lifecycle-stage owner, or the contact owner property?
