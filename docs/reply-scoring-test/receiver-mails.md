# Receiver mails (the test lead's replies)

Replies from **Anita Rao, Facilities Manager at Greenfield Business Park**, to the EV charger
[sender mail](sender-mail.md), written the way people actually answer: a greeting, some context about their car
park, a sign-off, sometimes a full signature or "Sent from my iPhone".

Send each one **from your test address** with Gmail's Reply button on the sender mail (subject `Re: EV charging for Greenfield Business Park`),
and paste the text in the box. Leave the quoted original Gmail adds below it: it is ignored, and so are the
signature and "Sent from my iPhone". Every reply becomes its own row on Positive Leads.

The expected group is what the keywords decide when nobody has labelled the reply. Each one was checked against
`app/reply_rules.py` on branch `fix/reply-scoring`, with and without Gmail's quoted original.

| # | What it tests | Expected group | Reason shown (Needs review / Unsubscribe) |
|---|---|---|---|
| R01 | Wants a call | **Positive** |  |
| R02 | Picks a day, from a phone | **Positive** |  |
| R03 | Wants pricing and case studies | **Positive** |  |
| R04 | Says sorry and "unfortunately", but wants to talk | **Positive** |  |
| R05 | Short and keen | **Positive** |  |
| R06 | Shares a booking link | **Positive** |  |
| R07 | Reply above our quoted email, brings the electrician | **Positive** |  |
| R08 | Wants a demo of the app | **Positive** |  |
| R09 | Asks the price | **Questions** |  |
| R10 | Has chargers already, asks about them | **Questions** |  |
| R11 | Busy, but asks the cost | **Questions** |  |
| R12 | Worried about the power supply | **Questions** |  |
| R13 | Doesn't know who you are | **Questions** |  |
| R14 | Polite interest, no next step | **Needs review** | Score 0.65: no clear yes or no |
| R15 | Asks to be contacted later | **Needs review** | Asks to be contacted later |
| R16 | Points to someone else | **Needs review** | Points you to someone else: write to them |
| R17 | Forwarded to the owners | **Needs review** | Points you to someone else: write to them |
| R18 | A short "not now" | **Needs review** | Score 0.30: only a soft no (it may mean later) |
| R19 | Says no this year, yes next year | **Needs review** | Score 0.55: says both yes and no |
| R20 | A yes phrase after "can't" | **Needs review** | Score 0.30: only a soft no (it may mean later) |
| R21 | Busy sentence with no clear answer | **Needs review** | No keywords matched |
| R22 | Just "Ok" from a phone | **Needs review** | Score 0.65: no clear yes or no |
| R23 | Clear no | **Not interested** |  |
| R24 | Already has a provider | **Not interested** |  |
| R25 | Chose someone else | **Not interested** |  |
| R26 | Leases the building | **Not interested** |  |
| R27 | Polite pass | **Not interested** |  |
| R28 | "Don't send me" plus a no | **Not interested** |  |
| R29 | Annoyed | **Not interested** |  |
| R30 | Asks to be removed | **Unsubscribe** | It seems to ask not to be contacted again |
| R31 | Tired of the emails | **Unsubscribe** | It seems to ask not to be contacted again |
| R32 | Blunt, from a phone | **Unsubscribe** | It seems to ask not to be contacted again |
| R33 | Out-of-office auto-reply | **Not listed** (saved as out of office) | |

In total: 8 Positive, 5 Questions, 9 Needs review, 7 Not interested, 3 Unsubscribe, and 1 out-of-office.

## Positive

### R01: Wants a call

Expected: **Positive**

```
Hi Shivam,

Good timing, actually. Three of our tenants have asked about charging in the last month and we have nothing in place yet.

Let's talk next week. Does Wednesday at 11am work for you? If not, Thursday morning is also free on my side.

Best regards,
Anita Rao
Facilities Manager | Greenfield Business Park
+91 98450 12345
```

### R02: Picks a day, from a phone

Expected: **Positive**

```
Hey Shivam,

Sure, this could be useful for us. Does Thursday work for a quick call? I'm around after 3.

Anita

Sent from my iPhone
```

### R03: Wants pricing and case studies

Expected: **Positive**

```
Hi Shivam,

This sounds interesting. We have about 400 parking spaces over two levels, and the basement has limited power capacity.

Can you send over pricing for 10 chargers, and some case studies from business parks like ours? I need to show the numbers to our owners first.

Thanks,
Anita Rao
Facilities Manager | Greenfield Business Park
+91 98450 12345
```

### R04: Says sorry and "unfortunately", but wants to talk

Expected: **Positive**

```
Hi Shivam,

Apologies for the late reply. Unfortunately I was away most of last week and I'm only catching up on email now.

Can we talk next week instead? Monday or Tuesday afternoon would suit me.

Regards,
Anita
```

### R05: Short and keen

Expected: **Positive**

```
Count me in. Send me a few times that work and I'll book one.

A
```

### R06: Shares a booking link

Expected: **Positive**

```
Hi Shivam,

Happy to chat. Here's my calendly, pick any slot that suits you: calendly.com/anita-greenfield/30min

Anita
```

### R07: Reply above our quoted email, brings the electrician

Expected: **Positive**

```
Sounds good, let's talk. I'll loop in our electrical contractor as well so they can answer the technical questions.

Anita
```

### R08: Wants a demo of the app

Expected: **Positive**

```
Hi Shivam,

We'd love a demo of the driver app before anything else. Our tenants will care most about how they pay and book a charger.

Anita
```

## Questions

### R09: Asks the price

Expected: **Questions**

```
Hi Shivam,

Quick question before I take this to our owners: what does a 7 kW charger cost installed, and is the no-upfront option a monthly fee or a share of the charging revenue?

Thanks,
Anita Rao
Facilities Manager | Greenfield Business Park
+91 98450 12345
```

### R10: Has chargers already, asks about them

Expected: **Questions**

```
Hi,

We already have two chargers from another company and they are often out of order. How would you handle maintenance, and could your app work with the existing ones?

Anita Rao
Facilities Manager | Greenfield Business Park
+91 98450 12345
```

### R11: Busy, but asks the cost

Expected: **Questions**

```
Hi Shivam,

I'm too busy with our annual audit to look at this properly. What would it cost, roughly? A ballpark figure is fine.

Anita
```

### R12: Worried about the power supply

Expected: **Questions**

```
Hi Shivam,

Our main concern is the power supply. Would 10 chargers need a transformer upgrade, and who handles the approval from the electricity board?

Anita
```

### R13: Doesn't know who you are

Expected: **Questions**

```
Hello,

Who is this? I don't recall us speaking before.

Anita
```

## Needs review

### R14: Polite interest, no next step

Expected: **Needs review** — "Score 0.65: no clear yes or no"

```
Hi Shivam,

Thanks for the note. Sounds interesting, I'll take a look at your website when I get a chance.

Best,
Anita
```

### R15: Asks to be contacted later

Expected: **Needs review** — "Asks to be contacted later"

```
Hi Shivam,

We're in the middle of resurfacing the car park right now. Ping me in a couple of months and we can look at it then.

Thanks,
Anita
```

### R16: Points to someone else

Expected: **Needs review** — "Points you to someone else: write to them"

```
Hi Shivam,

I'm not the right person for this. I'm cc'ing Vikram, our Head of Operations, who handles capital projects.

Best,
Anita Rao
Facilities Manager | Greenfield Business Park
+91 98450 12345
```

### R17: Forwarded to the owners

Expected: **Needs review** — "Points you to someone else: write to them"

```
Hi Shivam,

I've forwarded this to our owners. They decide on anything that touches the electrical setup.

Anita
```

### R18: A short "not now"

Expected: **Needs review** — "Score 0.30: only a soft no (it may mean later)"

```
Not now, thanks.

Anita
```

### R19: Says no this year, yes next year

Expected: **Needs review** — "Score 0.55: says both yes and no"

```
Hi Shivam,

Not right now, our budget for this year is already committed. But let's talk in Q1 when we plan next year's projects.

Anita
```

### R20: A yes phrase after "can't"

Expected: **Needs review** — "Score 0.30: only a soft no (it may mean later)"

```
Hi Shivam,

We can't schedule a call this month, the building is going through its fire safety inspection.

Regards,
Anita
```

### R21: Busy sentence with no clear answer

Expected: **Needs review** — "No keywords matched"

```
Hi,

I'm in back-to-back tenant meetings all day, will read this properly later and get back to you.

Anita
```

### R22: Just "Ok" from a phone

Expected: **Needs review** — "Score 0.65: no clear yes or no"

```
Ok.

Sent from my iPhone
```

## Not interested

### R23: Clear no

Expected: **Not interested**

```
Hi Shivam,

No thanks, we're all set for now.

Best of luck,
Anita
```

### R24: Already has a provider

Expected: **Not interested**

```
Hi Shivam,

Appreciate the outreach, but we already work with another company for our EV charging and we're happy with them.

Anita Rao
Facilities Manager | Greenfield Business Park
+91 98450 12345
```

### R25: Chose someone else

Expected: **Not interested**

```
Hi Shivam,

Thanks, but we've decided to go with another provider for the chargers. Installation starts next month.

Anita
```

### R26: Leases the building

Expected: **Not interested**

```
Hi,

We lease this building, so installing chargers isn't our call. Not for us, sorry.

Anita
```

### R27: Polite pass

Expected: **Not interested**

```
Thanks Shivam, but we'll pass.

Anita
```

### R28: "Don't send me" plus a no

Expected: **Not interested**

```
Don't send me more info, we are not buying anything this year.

Anita
```

### R29: Annoyed

Expected: **Not interested**

```
How did you get my email? I never signed up for this.

Anita
```

## Unsubscribe

### R30: Asks to be removed

Expected: **Unsubscribe** — "It seems to ask not to be contacted again"

```
Hi,

Please remove me from your list.

Thanks,
Anita Rao
Facilities Manager | Greenfield Business Park
+91 98450 12345
```

### R31: Tired of the emails

Expected: **Unsubscribe** — "It seems to ask not to be contacted again"

```
No more emails please. This is the third one about chargers this month.

Anita
```

### R32: Blunt, from a phone

Expected: **Unsubscribe** — "It seems to ask not to be contacted again"

```
Stop emailing me.

Sent from my iPhone
```

## Not listed

### R33: Out-of-office auto-reply

Change the subject to `Automatic reply: EV charging for Greenfield Business Park` before sending. Expected: it does **not** appear on Positive Leads
(saved as out of office).

```
Thank you for your email. I am out of the office until Monday 2 November with limited access to email.

For anything urgent about the car park, please contact facilities@greenfield.example.

Anita Rao
```
