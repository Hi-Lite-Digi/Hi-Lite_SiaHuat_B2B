from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfbase import pdfmetrics
from reportlab.platypus import (
    BaseDocTemplate,
    Flowable,
    Frame,
    KeepTogether,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output" / "pdf" / "Sia_Huat_Claire_Owner_User_Guide.pdf"

PAGE_W, PAGE_H = A4
MARGIN_X = 18 * mm
MARGIN_TOP = 19 * mm
MARGIN_BOTTOM = 17 * mm
CONTENT_W = PAGE_W - 2 * MARGIN_X

DARK = colors.HexColor("#113B33")
GREEN = colors.HexColor("#176853")
MID_GREEN = colors.HexColor("#2B7A67")
PALE = colors.HexColor("#DDEFE8")
PALE_2 = colors.HexColor("#EDF7F3")
GOLD = colors.HexColor("#F5AE2B")
CREAM = colors.HexColor("#F6F2E8")
INK = colors.HexColor("#304840")
MUTED = colors.HexColor("#6D7F79")
LINE = colors.HexColor("#C9DCD5")
WHITE = colors.white
RED = colors.HexColor("#A23B3B")

LIVE_URL = "https://hi-lite-sia-huat-b2-b.vercel.app/"


def register_fonts():
    candidates = [
        Path("C:/Windows/Fonts/arial.ttf"),
        Path("C:/Windows/Fonts/calibri.ttf"),
    ]
    bold_candidates = [
        Path("C:/Windows/Fonts/arialbd.ttf"),
        Path("C:/Windows/Fonts/calibrib.ttf"),
    ]
    regular = next((p for p in candidates if p.exists()), None)
    bold = next((p for p in bold_candidates if p.exists()), None)
    if regular and bold:
        pdfmetrics.registerFont(TTFont("GuideSans", str(regular)))
        pdfmetrics.registerFont(TTFont("GuideSans-Bold", str(bold)))
        return "GuideSans", "GuideSans-Bold"
    return "Helvetica", "Helvetica-Bold"


FONT, FONT_BOLD = register_fonts()


styles = getSampleStyleSheet()
styles.add(
    ParagraphStyle(
        name="GuideTitle",
        fontName=FONT_BOLD,
        fontSize=26,
        leading=31,
        textColor=WHITE,
        spaceAfter=6,
    )
)
styles.add(
    ParagraphStyle(
        name="GuideSubtitle",
        fontName=FONT,
        fontSize=12.5,
        leading=18,
        textColor=colors.HexColor("#E7F4EF"),
    )
)
styles.add(
    ParagraphStyle(
        name="PageTitle",
        fontName=FONT_BOLD,
        fontSize=21,
        leading=25,
        textColor=DARK,
        spaceAfter=5,
    )
)
styles.add(
    ParagraphStyle(
        name="Section",
        fontName=FONT_BOLD,
        fontSize=12.7,
        leading=16,
        textColor=GREEN,
        spaceBefore=4,
        spaceAfter=5,
    )
)
styles.add(
    ParagraphStyle(
        name="BodyGuide",
        fontName=FONT,
        fontSize=9.7,
        leading=14.2,
        textColor=INK,
        spaceAfter=5,
    )
)
styles.add(
    ParagraphStyle(
        name="SmallGuide",
        fontName=FONT,
        fontSize=8.4,
        leading=11.8,
        textColor=MUTED,
    )
)
styles.add(
    ParagraphStyle(
        name="BulletGuide",
        fontName=FONT,
        fontSize=9.4,
        leading=13.8,
        textColor=INK,
        leftIndent=10,
        firstLineIndent=-7,
        bulletIndent=0,
        spaceAfter=3.5,
    )
)
styles.add(
    ParagraphStyle(
        name="Example",
        fontName=FONT,
        fontSize=9.6,
        leading=14,
        textColor=DARK,
    )
)
styles.add(
    ParagraphStyle(
        name="CalloutTitle",
        fontName=FONT_BOLD,
        fontSize=9.3,
        leading=12.3,
        textColor=GREEN,
        spaceAfter=2,
    )
)
styles.add(
    ParagraphStyle(
        name="TableHeader",
        fontName=FONT_BOLD,
        fontSize=9.2,
        leading=12,
        textColor=WHITE,
    )
)
styles.add(
    ParagraphStyle(
        name="StepNumber",
        fontName=FONT_BOLD,
        fontSize=11,
        leading=13,
        alignment=TA_CENTER,
        textColor=DARK,
    )
)
styles.add(
    ParagraphStyle(
        name="StepTitle",
        fontName=FONT_BOLD,
        fontSize=10,
        leading=13,
        textColor=DARK,
        spaceAfter=2,
    )
)
styles.add(
    ParagraphStyle(
        name="StepBody",
        fontName=FONT,
        fontSize=8.4,
        leading=11.6,
        textColor=INK,
    )
)


def P(text, style="BodyGuide"):
    return Paragraph(text, styles[style])


def bullet(text):
    return Paragraph("- " + text, styles["BulletGuide"])


class Rule(Flowable):
    def __init__(self, color=LINE, width=0.7, space=5):
        super().__init__()
        self.color = color
        self.line_width = width
        self.space = space
        self.height = space * 2

    def wrap(self, avail_width, avail_height):
        self._availWidth = avail_width
        return avail_width, self.height

    def draw(self):
        self.canv.setStrokeColor(self.color)
        self.canv.setLineWidth(self.line_width)
        self.canv.line(0, self.space, self._availWidth, self.space)


def callout(title, body, tone="green"):
    palette = {
        "green": (PALE_2, GREEN),
        "gold": (colors.HexColor("#FFF4D8"), colors.HexColor("#A36B00")),
        "red": (colors.HexColor("#FCE8E8"), RED),
    }
    bg, accent = palette[tone]
    table = Table(
        [[P(title, "CalloutTitle"), P(body, "BodyGuide")]],
        colWidths=[34 * mm, CONTENT_W - 34 * mm],
        hAlign="LEFT",
    )
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), bg),
                ("BOX", (0, 0), (-1, -1), 0.6, colors.Color(accent.red, accent.green, accent.blue, alpha=0.35)),
                ("LINEBEFORE", (0, 0), (0, -1), 3, accent),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 8),
                ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                ("TOPPADDING", (0, 0), (-1, -1), 7),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
            ]
        )
    )
    return table


def example_box(label, text):
    label_cell = Table(
        [[Paragraph(label.upper(), ParagraphStyle(name="Label", fontName=FONT_BOLD, fontSize=7.5, leading=9, textColor=WHITE, alignment=TA_CENTER))]],
        colWidths=[28 * mm],
        rowHeights=[7 * mm],
    )
    label_cell.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), GREEN), ("VALIGN", (0, 0), (-1, -1), "MIDDLE")]))
    body = Table([[label_cell, P(text, "Example")]], colWidths=[31 * mm, CONTENT_W - 31 * mm])
    body.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), CREAM),
                ("BOX", (0, 0), (-1, -1), 0.5, LINE),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LEFTPADDING", (0, 0), (0, 0), 5),
                ("RIGHTPADDING", (0, 0), (0, 0), 3),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
                ("LEFTPADDING", (1, 0), (1, 0), 8),
                ("RIGHTPADDING", (1, 0), (1, 0), 8),
            ]
        )
    )
    return body


def step_card(number, title, body):
    circle = Table([[P(str(number), "StepNumber")]], colWidths=[10 * mm], rowHeights=[10 * mm])
    circle.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), GOLD),
                ("BOX", (0, 0), (-1, -1), 0, GOLD),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ]
        )
    )
    table = Table(
        [[circle, [P(title, "StepTitle"), P(body, "StepBody")]]],
        colWidths=[13 * mm, CONTENT_W - 13 * mm],
    )
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), PALE_2),
                ("BOX", (0, 0), (-1, -1), 0.5, LINE),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 7),
                ("RIGHTPADDING", (0, 0), (-1, -1), 7),
                ("TOPPADDING", (0, 0), (-1, -1), 7),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
            ]
        )
    )
    return table


def section_header(title, intro=None):
    items = [P(title, "PageTitle")]
    if intro:
        items.extend([P(intro, "BodyGuide"), Rule(space=3)])
    return items


def cover_page(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(CREAM)
    canvas.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    canvas.setFillColor(DARK)
    canvas.rect(0, PAGE_H - 128 * mm, PAGE_W, 128 * mm, fill=1, stroke=0)

    # Brand mark
    canvas.setFillColor(GOLD)
    canvas.circle(31 * mm, PAGE_H - 29 * mm, 10 * mm, fill=1, stroke=0)
    canvas.setFont(FONT_BOLD, 18)
    canvas.setFillColor(DARK)
    canvas.drawCentredString(31 * mm, PAGE_H - 32 * mm, "C")
    canvas.setFont(FONT_BOLD, 12)
    canvas.setFillColor(WHITE)
    canvas.drawString(47 * mm, PAGE_H - 27 * mm, "CLAIRE - SIA HUAT")
    canvas.setFont(FONT, 8.5)
    canvas.setFillColor(colors.HexColor("#CDE6DE"))
    canvas.drawString(47 * mm, PAGE_H - 34 * mm, "AI sales enquiry assistant")

    # Cover title
    canvas.setFillColor(WHITE)
    canvas.setFont(FONT_BOLD, 25)
    canvas.drawString(MARGIN_X, PAGE_H - 70 * mm, "OWNER USER GUIDE")
    canvas.setFont(FONT, 11.5)
    canvas.setFillColor(colors.HexColor("#E7F4EF"))
    canvas.drawString(MARGIN_X, PAGE_H - 81 * mm, "How to help customers find, compare and request Sia Huat products with Claire")
    canvas.setFillColor(GOLD)
    canvas.rect(MARGIN_X, PAGE_H - 101 * mm, 36 * mm, 2.5 * mm, fill=1, stroke=0)

    # Purpose card - fully below the hero area.
    purpose_y = 127 * mm
    canvas.setFillColor(PALE_2)
    canvas.roundRect(MARGIN_X, purpose_y, CONTENT_W, 30 * mm, 3 * mm, fill=1, stroke=0)
    canvas.setFillColor(GREEN)
    canvas.rect(MARGIN_X, purpose_y, 2 * mm, 30 * mm, fill=1, stroke=0)
    canvas.setFont(FONT_BOLD, 9)
    canvas.drawString(MARGIN_X + 6 * mm, purpose_y + 21 * mm, "PURPOSE")
    canvas.setFillColor(INK)
    canvas.setFont(FONT, 9)
    purpose_lines = [
        "A practical handover guide for owners, sales staff and operators.",
        "It covers product search, photos, multiple items, enquiry summaries, stock issues",
        "and the point where the operator must contact sales through an external channel.",
    ]
    for index, line in enumerate(purpose_lines):
        canvas.drawString(MARGIN_X + 39 * mm, purpose_y + (21 - index * 6) * mm, line)

    # Document facts card.
    facts_y = 78 * mm
    facts_h = 39 * mm
    canvas.setFillColor(WHITE)
    canvas.roundRect(MARGIN_X, facts_y, CONTENT_W, facts_h, 2 * mm, fill=1, stroke=0)
    canvas.setStrokeColor(LINE)
    canvas.setLineWidth(0.5)
    canvas.line(MARGIN_X + 37 * mm, facts_y, MARGIN_X + 37 * mm, facts_y + facts_h)
    canvas.line(MARGIN_X, facts_y + 13 * mm, MARGIN_X + CONTENT_W, facts_y + 13 * mm)
    canvas.line(MARGIN_X, facts_y + 26 * mm, MARGIN_X + CONTENT_W, facts_y + 26 * mm)
    fact_rows = [
        ("LIVE DEMO", LIVE_URL),
        ("GUIDE DATE", "02 September 2026"),
        ("DOCUMENT USE", "Client handover and staff training"),
    ]
    for index, (label, value) in enumerate(fact_rows):
        row_y = facts_y + facts_h - (index + 1) * 13 * mm
        canvas.setFont(FONT_BOLD, 8.2)
        canvas.setFillColor(GREEN)
        canvas.drawString(MARGIN_X + 5 * mm, row_y + 4.7 * mm, label)
        canvas.setFont(FONT, 8.5)
        canvas.setFillColor(INK)
        canvas.drawString(MARGIN_X + 42 * mm, row_y + 4.7 * mm, value)
    canvas.linkURL(LIVE_URL, (MARGIN_X + 42 * mm, facts_y + 26 * mm, MARGIN_X + CONTENT_W - 5 * mm, facts_y + 39 * mm), relative=0)

    # Demo limitation card.
    note_y = 43 * mm
    canvas.setFillColor(colors.HexColor("#FFF4D8"))
    canvas.roundRect(MARGIN_X, note_y, CONTENT_W, 24 * mm, 2 * mm, fill=1, stroke=0)
    canvas.setFillColor(colors.HexColor("#A36B00"))
    canvas.rect(MARGIN_X, note_y, 2 * mm, 24 * mm, fill=1, stroke=0)
    canvas.setFont(FONT_BOLD, 8.8)
    canvas.drawString(MARGIN_X + 6 * mm, note_y + 16.5 * mm, "IMPORTANT DEMO LIMIT")
    canvas.setFont(FONT, 8.5)
    canvas.setFillColor(INK)
    canvas.drawString(MARGIN_X + 6 * mm, note_y + 9.5 * mm, "Claire prepares an on-screen summary; it does not save, send or place an order.")
    canvas.drawString(MARGIN_X + 6 * mm, note_y + 4.5 * mm, "Download the PDF and manually send it to a Sia Huat sales contact for follow-up.")

    canvas.setFont(FONT, 7.8)
    canvas.setFillColor(MUTED)
    canvas.drawString(MARGIN_X, 25 * mm, "Client handover edition - capabilities scoped to the live demo")
    canvas.setFillColor(GOLD)
    canvas.rect(MARGIN_X, 18 * mm, 34 * mm, 2.5 * mm, fill=1, stroke=0)
    canvas.restoreState()


def later_page(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(CREAM)
    canvas.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    canvas.setFillColor(DARK)
    canvas.rect(0, PAGE_H - 14 * mm, PAGE_W, 14 * mm, fill=1, stroke=0)
    canvas.setFont(FONT_BOLD, 8.2)
    canvas.setFillColor(WHITE)
    canvas.drawString(MARGIN_X, PAGE_H - 9.2 * mm, "CLAIRE - SIA HUAT  |  OWNER USER GUIDE")
    canvas.setStrokeColor(LINE)
    canvas.setLineWidth(0.6)
    canvas.line(MARGIN_X, 13.2 * mm, PAGE_W - MARGIN_X, 13.2 * mm)
    canvas.setFont(FONT, 7.6)
    canvas.setFillColor(MUTED)
    canvas.drawString(MARGIN_X, 8.6 * mm, LIVE_URL)
    canvas.drawRightString(PAGE_W - MARGIN_X, 8.6 * mm, f"Page {doc.page}")
    canvas.restoreState()


def build_story():
    # The cover is drawn directly on the page canvas for precise placement.
    story = [Spacer(1, 1), PageBreak()]

    # Page 2
    story.extend(section_header("1. Start here", "Claire is designed to move a customer from a simple request to a clear, reviewable product enquiry."))
    story.append(P("The complete customer journey", "Section"))
    for number, title, body in [
        (1, "Ask", "Customer sends an item name, quantity and any important requirement. A photo can also be included."),
        (2, "Compare", "Claire presents suitable product choices with code, price, website stock status and product link."),
        (3, "Choose and confirm", "Customer replies with the product number, then confirms the exact item. Claire checks fresh stock before adding it."),
        (4, "Review", "Claire prepares a running enquiry summary. The customer can change quantity or use Add another item."),
        (5, "Finish and share manually", "Finish enquiry summary completes the on-screen summary only. Download its PDF and send it to a Sia Huat sales contact."),
    ]:
        story.extend([step_card(number, title, body), Spacer(1, 3 * mm)])
    story.append(Spacer(1, 2 * mm))
    story.append(callout("Golden rule", "A successful message usually contains three things: the product, the quantity and the key requirement. Example: Need 12 black food storage boxes around 20 by 15 inch.", "gold"))
    story.append(Spacer(1, 5 * mm))
    story.append(P("Starting a clean customer session", "Section"))
    story.append(bullet("Open the live website and wait for Claire's welcome message."))
    story.append(bullet("Use the PDF icon to download the current conversation. Review it before sharing because it may contain customer and enquiry details."))
    story.append(bullet("The PDF contains message text plus markers for an attached photo or voice transcript. It does not embed the original photo or audio; forward that media separately when sales needs it."))
    story.append(bullet("Voice input works only in a supported browser with microphone permission and configured transcription. If it is unavailable, type the item and quantity instead."))
    story.append(bullet("Download the PDF before reset, refresh or closing the tab. The demo has no owner inbox, shared queue or persistent conversation history."))
    story.append(bullet("Reset is immediate and irreversible in the current tab. Use it only after exporting any record you need, and before starting a new customer scenario."))
    story.append(PageBreak())

    # Page 3
    story.extend(section_header("2. Run a standard product enquiry", "Use natural customer language. Perfect spelling and formal product names are not required."))
    story.append(P("What the customer should send", "Section"))
    story.append(example_box("Customer", "Need 3 bread knives for my restaurant. What can I buy?"))
    story.append(Spacer(1, 4 * mm))
    story.append(P("What Claire should return", "Section"))
    story.append(bullet("A short list of matching product cards, normally numbered."))
    story.append(bullet("Product name, item code, price, catalogue website stock status and product link."))
    story.append(bullet("A clear next step such as Reply 1 or 2, or ask for more options."))
    story.append(Spacer(1, 4 * mm))
    story.append(P("Actual selection sequence", "Section"))
    selection = Table(
        [
            [P("Step", "TableHeader"), P("What happens", "TableHeader")],
            [P("1. Choose", "BodyGuide"), P("Customer replies with the product number, for example 2.", "BodyGuide")],
            [P("2. Confirm exact item", "BodyGuide"), P("Claire repeats the exact product and any quantity already supplied. The customer confirms it.", "BodyGuide")],
            [P("3. Fresh stock check", "BodyGuide"), P("Claire checks current website stock for that exact item.", "BodyGuide")],
            [P("4. Quantity if missing", "BodyGuide"), P("If no quantity was given, Claire asks for it. If known, it stays with the enquiry.", "BodyGuide")],
            [P("5. Summary", "BodyGuide"), P("Claire shows the selected line, quantity, price basis and next actions.", "BodyGuide")],
        ],
        colWidths=[48 * mm, CONTENT_W - 48 * mm],
    )
    selection.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), DARK), ("TEXTCOLOR", (0, 0), (-1, 0), WHITE), ("GRID", (0, 0), (-1, -1), 0.5, LINE), ("BACKGROUND", (0, 1), (-1, -1), WHITE), ("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 6), ("RIGHTPADDING", (0, 0), (-1, -1), 6), ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4)]))
    story.append(selection)
    story.append(Spacer(1, 5 * mm))
    story.append(P("How to get better matches", "Section"))
    two_col = Table(
        [
            [P("Useful detail", "TableHeader"), P("Example", "TableHeader")],
            [P("Quantity", "BodyGuide"), P("Need 24 pieces", "BodyGuide")],
            [P("Size or capacity", "BodyGuide"), P("15cm blade or 12QT pot", "BodyGuide")],
            [P("Colour or material", "BodyGuide"), P("Red handle, stainless steel", "BodyGuide")],
            [P("Use or environment", "BodyGuide"), P("For restaurant storage", "BodyGuide")],
            [P("Must-have fit", "BodyGuide"), P("Strainer must fit the 12QT pot", "BodyGuide")],
        ],
        colWidths=[50 * mm, CONTENT_W - 50 * mm],
    )
    two_col.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), DARK), ("TEXTCOLOR", (0, 0), (-1, 0), WHITE), ("GRID", (0, 0), (-1, -1), 0.5, LINE), ("BACKGROUND", (0, 1), (-1, -1), WHITE), ("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 7), ("RIGHTPADDING", (0, 0), (-1, -1), 7), ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6)]))
    story.append(two_col)
    story.append(Spacer(1, 6 * mm))
    story.append(callout("Owner check", "The product card is an initial catalogue result. Claire runs a fresh website stock check after the exact item is confirmed. A sales person must still verify fit, final price, stock allocation and fulfilment before making a promise.", "green"))
    story.append(PageBreak())

    # Page 4
    story.extend(section_header("3. Ask for more items or change the request", "Customers can be casual, change their mind, reject a brand, or ask for different choices."))
    story.append(P("Ask for different products", "Section"))
    for message in [
        "Got more items? Different ones please, any brand can, still need 3.",
        "Any more? Show different bread knives, still 3.",
        "Other similar one can? Same black box, roughly 20 by 15 inch, still need 2.",
    ]:
        story.extend([example_box("Customer", message), Spacer(1, 3 * mm)])
    story.append(callout("What Claire remembers", "Within the current open tab, Claire can carry the product type, quantity and clear requirements into the next turn. Already shown products should not be repeated when the customer asks for different ones.", "green"))
    story.append(Spacer(1, 5 * mm))
    story.append(P("Reject a brand or specification", "Section"))
    story.append(example_box("Customer", "Not Atlantic Chef. Same red handle and 15cm."))
    story.append(Spacer(1, 4 * mm))
    story.append(P("Change your mind later", "Section"))
    story.append(example_box("Customer", "Actually Atlantic Chef is okay. Need 500 of that exact knife."))
    story.append(Spacer(1, 4 * mm))
    story.append(callout("Expected behaviour", "Claire can update a simple restriction when the change is explicit, but restriction editing is not universal for every compound request. For safety, restate the full current requirement after changing brand, size, material or quantity. Large quantities require a manual sales stock and lead-time check.", "gold"))
    story.append(Spacer(1, 5 * mm))
    story.append(P("If the wording is vague", "Section"))
    story.append(bullet("Keep a clearly confirmed product and quantity. If either is uncertain, restate the full current requirement."))
    story.append(bullet("Ask only for the missing detail that affects the purchase, such as size, capacity, material or budget."))
    story.append(bullet("Do not ask again for a photo or reference that is already present in the conversation."))
    story.append(PageBreak())

    # Page 5
    story.extend(section_header("4. Use a product photo", "Photo enquiries are best when the customer shows one clear product and adds a short buying requirement."))
    story.append(P("How to send a photo", "Section"))
    story.append(step_card(1, "Add the image", "Paste, drag and drop, or click the image area to choose a product photo."))
    story.append(Spacer(1, 3 * mm))
    story.append(step_card(2, "Add buying context", "Write the quantity and intended use. Add any visible or known size, colour, material or brand requirement."))
    story.append(Spacer(1, 3 * mm))
    story.append(step_card(3, "Review the matches", "Check that the suggested cards are the same product type before selecting one."))
    story.append(Spacer(1, 5 * mm))
    story.append(example_box("Customer", "Need 2 of this for restaurant storage. What can I buy?"))
    story.append(Spacer(1, 3 * mm))
    story.append(example_box("Follow-up", "Other similar one can? Same black box, roughly 20 by 15 inch, still need 2."))
    story.append(Spacer(1, 6 * mm))
    story.append(P("Photo tips", "Section"))
    story.append(bullet("Use a well-lit image with the product taking up most of the frame."))
    story.append(bullet("Use JPG, PNG or WebP. The file must be smaller than 5 MB."))
    story.append(bullet("Avoid screenshots containing several unrelated products unless the customer names the exact item."))
    story.append(bullet("If the model number or label is visible, type it in the message as well."))
    story.append(bullet("For fit-sensitive products, include measurements. A photo cannot prove that a strainer fits a pot or that a lid fits a pan."))
    story.append(Spacer(1, 5 * mm))
    story.append(callout("If the photo is unclear", "Claire should ask for one useful detail or prepare a staff-review summary. It should not confidently name an unrelated product or force the customer to start again. No staff member is notified automatically.", "red"))
    story.append(PageBreak())

    # Page 6
    story.extend(section_header("5. Build a multiple-item enquiry", "Claire can keep adding products to one on-screen enquiry summary while the current tab remains open."))
    story.append(P("Recommended flow", "Section"))
    for number, title, body in [
        (1, "Find item one", "State the first product, quantity and required specification."),
        (2, "Select and confirm", "Reply with the card number, confirm the exact item and let Claire run the fresh stock check."),
        (3, "Add another item", "Use Add another item, then describe one next product and its quantity in normal language."),
        (4, "Repeat one item at a time", "Use a new Add another item cycle for each size or variant. Each confirmed item should appear in the running summary."),
        (5, "Finish and export", "Check all item codes, quantities and totals. Choose Finish enquiry summary, download the PDF and manually send it to sales."),
    ]:
        story.extend([step_card(number, title, body), Spacer(1, 2.6 * mm)])
    story.append(Spacer(1, 3 * mm))
    story.append(P("Example conversation", "Section"))
    story.append(example_box("Item 1", "Need one 12QT stainless steel pot."))
    story.append(Spacer(1, 3 * mm))
    story.append(example_box("Add item 2", "Add another item: need one strainer for the 12QT pot. Sales must confirm the fit."))
    story.append(Spacer(1, 3 * mm))
    story.append(example_box("Next cycle", "For 4oz, 6oz and 8oz ladles, add each size in its own Add another item cycle."))
    story.append(Spacer(1, 5 * mm))
    story.append(callout("Before manual sharing", "Check every line in the summary, including item code, description, quantity, price basis and GST wording. Finish enquiry summary only completes the screen: it does not save, transmit, place an order or notify staff. Download the PDF and send it through the agreed sales channel.", "gold"))
    story.append(PageBreak())

    # Page 7
    story.extend(section_header("6. Stock, unavailable items and errors", "Claire should help the customer make progress even when the exact product cannot be bought immediately."))
    story.append(P("When stock is insufficient", "Section"))
    story.append(bullet("State that the requested quantity is not currently supported by the website stock shown."))
    story.append(bullet("Do not suggest buying a smaller quantity if the item is completely out of stock."))
    story.append(bullet("Do not allow a completely out-of-stock product card to be selected."))
    story.append(bullet("Offer a useful next action: different item, relax one requirement, or prepare details for the customer or operator to send to sales manually."))
    story.append(Spacer(1, 5 * mm))
    story.append(P("Helpful recovery choices", "Section"))
    recovery = Table(
        [
            [P("Situation", "TableHeader"), P("Best next action", "TableHeader")],
            [P("No exact brand match", "BodyGuide"), P("Ask whether another brand is acceptable.", "BodyGuide")],
            [P("No item at exact size", "BodyGuide"), P("Ask for an acceptable size range.", "BodyGuide")],
            [P("Large quantity", "BodyGuide"), P("Prepare the quantity and item details, then contact sales manually for stock and lead time.", "BodyGuide")],
            [P("Compatibility unclear", "BodyGuide"), P("Collect model or measurements, export the summary and ask sales to confirm.", "BodyGuide")],
            [P("Request timed out", "BodyGuide"), P("Retry the last message once. Keep it short and specific.", "BodyGuide")],
        ],
        colWidths=[58 * mm, CONTENT_W - 58 * mm],
    )
    recovery.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), DARK), ("TEXTCOLOR", (0, 0), (-1, 0), WHITE), ("GRID", (0, 0), (-1, -1), 0.5, LINE), ("BACKGROUND", (0, 1), (-1, -1), WHITE), ("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 7), ("RIGHTPADDING", (0, 0), (-1, -1), 7), ("TOPPADDING", (0, 0), (-1, -1), 7), ("BOTTOMPADDING", (0, 0), (-1, -1), 7)]))
    story.append(recovery)
    story.append(Spacer(1, 6 * mm))
    story.append(callout("Functional quality test", "A reply is successful only if it helps the customer buy, compare or reach a sensible human next step. Correct understanding without a useful response is not enough.", "green"))
    story.append(PageBreak())

    # Page 8
    story.extend(section_header("7. Know when a person should take over", "Claire supports the buying journey, but a sales owner remains responsible for commitments and exceptions."))
    story.append(P("Escalate to a person for", "Section"))
    for item in [
        "Quotation status, missing quotation, special pricing or formal quotation documents.",
        "Payment confirmation, bank transfer, PayNow, invoice or receipt questions.",
        "Delivery dates, delivery restrictions, urgent delivery or a closed outlet schedule.",
        "Exact fit or compatibility that cannot be proven from the catalogue details.",
        "Custom sourcing, unavailable products, special brands or unusually large quantities.",
        "Any request where the customer is dissatisfied or the same clarification repeats.",
    ]:
        story.append(bullet(item))
    story.append(Spacer(1, 5 * mm))
    story.append(P("Safe handoff wording", "Section"))
    story.append(example_box("Claire", "I could not confirm an exact match. I have kept your quantity and requirements in this on-screen summary. Download the PDF and share it with your Sia Huat sales contact."))
    story.append(Spacer(1, 5 * mm))
    story.append(callout("Manual handoff", "Nothing is sent automatically. The demo has no owner inbox, shared queue, persistent history, automatic email or WhatsApp notification. Keep the tab open or export the PDF, then use the agreed external sales channel and tracking process.", "gold"))
    story.append(Spacer(1, 3 * mm))
    story.append(callout("Never promise", "Do not confirm stock allocation, final quotation, payment approval or delivery timing unless a responsible person has verified it.", "red"))
    story.append(Spacer(1, 6 * mm))
    story.append(P("Daily owner checklist", "Section"))
    checks = [
        "Open the live assistant and run one simple enquiry.",
        "Check that product cards show a working link, realistic price and clear stock status.",
        "Run one ask for more items message and confirm that new products appear.",
        "Run one photo enquiry using a known product image.",
        "Review PDFs and notes received through the team's external sales channel or tracking process.",
        "Record repeated failures so the catalogue or assistant rules can be improved.",
    ]
    for i, item in enumerate(checks, start=1):
        story.append(Paragraph(f"[ ] {i}. {item}", styles["BulletGuide"]))
    story.append(PageBreak())

    # Page 9
    story.extend(section_header("8. Copy-ready customer scripts", "These examples are intentionally simple and natural. Customers do not need perfect grammar."))
    scripts = [
        ("Normal purchase", "Need 6 red-handle chef knives, around 15cm, for restaurant use. What can I buy?"),
        ("More choices", "Got more items? Show different ones, any brand can, still need 6."),
        ("Photo enquiry", "Need 2 of the item in this photo. Same colour and roughly the same size."),
        ("Multiple items - first cycle", "Need 4 half-size stainless steel pans, 6 inch deep."),
        ("Multiple items - next cycle", "Add another item: need 4 matching lids with ladle notches. Sales must confirm the fit."),
        ("Change mind", "Actually the first brand is okay. Keep the same size and quantity."),
        ("Staff review", "No exact match is fine. Prepare the closest option details for me to download and share with sales."),
    ]
    for label, text_value in scripts:
        story.extend([example_box(label, text_value), Spacer(1, 3 * mm)])
    story.append(Spacer(1, 3 * mm))
    story.append(P("Client handover checklist", "Section"))
    for item in [
        "Assign one sales owner and an external contact channel for follow-ups.",
        "Agree an internal response-time target.",
        "Confirm who verifies price, stock, quotation, payment and delivery.",
        "Track exported summaries in the team's existing inbox, CRM or shared log.",
        "Keep product catalogue data and website stock information current.",
        "Export any needed record before reset, refresh or closing the tab.",
    ]:
        story.append(Paragraph("[ ] " + item, styles["BulletGuide"]))
    story.append(Spacer(1, 4 * mm))
    story.append(callout("Final reminder", "Claire is most useful when each reply ends with a clear buying action: choose a product, supply one missing requirement, ask for another option, add an item, finish the summary, or download it and contact sales manually.", "gold"))

    return story


def main():
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    frame = Frame(
        MARGIN_X,
        MARGIN_BOTTOM,
        PAGE_W - 2 * MARGIN_X,
        PAGE_H - MARGIN_TOP - MARGIN_BOTTOM,
        leftPadding=0,
        rightPadding=0,
        topPadding=0,
        bottomPadding=0,
    )
    doc = BaseDocTemplate(
        str(OUTPUT),
        pagesize=A4,
        leftMargin=MARGIN_X,
        rightMargin=MARGIN_X,
        topMargin=MARGIN_TOP,
        bottomMargin=MARGIN_BOTTOM,
        title="Claire - Sia Huat Owner User Guide",
        author="Hi-Lite / Sia Huat",
        subject="Client handover manual for the Claire AI sales assistant",
    )
    doc.addPageTemplates(
        [
            PageTemplate(id="Guide", frames=[frame], onPage=lambda canvas, d: cover_page(canvas, d) if d.page == 1 else later_page(canvas, d)),
        ]
    )
    doc.build(build_story())
    print(OUTPUT)


if __name__ == "__main__":
    main()
