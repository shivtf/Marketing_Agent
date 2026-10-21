# Sender mail (the outreach email)

An outreach email offering workplace EV chargers to a made-up lead, **Anita Rao, Facilities Manager at Greenfield
Business Park**. Every reply in [receiver-mails.md](receiver-mails.md) answers it.

It must be **sent by the Marketing Agent**, so it is saved in the `emails` table: the dashboard only counts a reply
when it answers one of our recorded emails (see [README.md](README.md), step 2). Use this text as the email the agent
sends, or compare it with what the agent wrote.

**From:** the outreach mailbox (the Gmail connected on the History page)
**To:** your test address (a second mailbox you own, not the connected one)
**Subject:** EV charging for Greenfield Business Park

```
Hi Anita,

I noticed Greenfield Business Park has taken on several new tenants this year. More of their employees are switching
to electric cars, and many office parks now offer charging in the car park as a standard amenity.

We install and run workplace EV chargers (7 kW AC and 30 kW DC). Smart load management keeps the chargers within your
building's power supply, and drivers pay through our app, so you don't have to handle billing. There is also a
no-upfront-cost option where we own and maintain the chargers.

Would you be open to a 20-minute call next week to see if it fits your site?

Thanks,
Shivam

Unsubscribe: https://example.com/unsubscribe/test
```

The `Unsubscribe:` line is on purpose: it checks that our own footer, quoted back in a reply, is never mistaken for
the lead asking to stop.
