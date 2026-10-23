import crypto from "crypto";

/**
 * LHDN's e-invoice as a document: UBL 2.1 in the JSON form MyInvois takes,
 * version 1.0 (no digital signature), shaped after LHDN's own samples
 * (sdk.myinvois.hasil.gov.my/sample). Every value is `[{ "_": value }]`, with
 * attributes beside `_`. Nothing here talks to LHDN; it only writes.
 */

export interface Party {
  tin: string;
  /** Business registration (BRN), or the buyer's NRIC or passport number, with which it is. */
  idType: "BRN" | "NRIC" | "PASSPORT" | "ARMY";
  idNumber: string;
  sst?: string | null;
  name: string;
  addressLine: string;
  city: string;
  postcode: string;
  /** LHDN's state code: 01 Johor … 14 Kuala Lumpur, 17 not applicable. */
  stateCode: string;
  /** ISO 3166-1 alpha-3. */
  country: string;
  phone: string;
  email: string;
}

export interface Supplier extends Party {
  msicCode: string;
  msicName: string;
}

export interface DocLine {
  description: string;
  /** Including tax. */
  gross: number;
  tax: number;
  /** Percent; null when untaxed. */
  rate: number | null;
  /** LHDN classification: 004 consolidated, 022 others. */
  classification: string;
}

export interface DocInput {
  typeCode: "01" | "02";
  codeNumber: string;
  issuedAt: Date;
  currency: string;
  supplier: Supplier;
  /** Null: the consolidated buyer, the general public. */
  buyer: Party | null;
  lines: DocLine[];
  /** A credit note: the e-invoice it corrects. */
  refers?: { codeNumber: string; uuid: string } | null;
}

/** The buyer LHDN has every consolidated e-invoice made out to. */
export const GENERAL_PUBLIC_TIN = "EI00000000010";

export { STATE_CODES } from "./states";

const v = (value: string | number, attrs: Record<string, string> = {}) => [{ _: value, ...attrs }];
const round = (n: number) => Math.round(n * 100) / 100;

function partyIds(p: Party) {
  return [
    { ID: v(p.tin, { schemeID: "TIN" }) },
    { ID: v(p.idNumber || "NA", { schemeID: p.idType }) },
    { ID: v(p.sst || "NA", { schemeID: "SST" }) },
    { ID: v("NA", { schemeID: "TTX" }) },
  ];
}

function address(p: Party) {
  return [
    {
      CityName: v(p.city),
      PostalZone: v(p.postcode),
      CountrySubentityCode: v(p.stateCode),
      AddressLine: [{ Line: v(p.addressLine || "NA") }],
      Country: [{ IdentificationCode: v(p.country, { listID: "ISO3166-1", listAgencyID: "6" }) }],
    },
  ];
}

const GENERAL_PUBLIC: Party = {
  tin: GENERAL_PUBLIC_TIN,
  idType: "BRN",
  idNumber: "NA",
  name: "General Public",
  addressLine: "NA",
  city: "NA",
  postcode: "",
  stateCode: "17",
  country: "MYS",
  phone: "NA",
  email: "NA",
};

/** Service tax where the venue charges SST, else not applicable (LHDN tax types 02 and 06). */
function taxCategory(rate: number | null) {
  return [{ ID: v(rate ? "02" : "06"), TaxScheme: [{ ID: v("OTH", { schemeID: "UN/ECE 5153", schemeAgencyID: "6" }) }] }];
}

/** The document as MyInvois takes it, and its numbers. */
export function buildDocument(input: DocInput): { json: string; net: number; tax: number; gross: number } {
  const cur = { currencyID: input.currency };
  const lines = input.lines.map((l, i) => {
    const net = round(l.gross - l.tax);
    return {
      ID: v(String(i + 1)),
      InvoicedQuantity: v(1, { unitCode: "C62" }),
      LineExtensionAmount: v(net, cur),
      TaxTotal: [
        {
          TaxAmount: v(round(l.tax), cur),
          TaxSubtotal: [
            {
              TaxableAmount: v(net, cur),
              TaxAmount: v(round(l.tax), cur),
              Percent: v(l.rate ?? 0),
              TaxCategory: taxCategory(l.rate),
            },
          ],
        },
      ],
      Item: [
        {
          CommodityClassification: [{ ItemClassificationCode: v(l.classification, { listID: "CLASS" }) }],
          Description: v(l.description.slice(0, 300)),
          OriginCountry: [{ IdentificationCode: v("MYS") }],
        },
      ],
      Price: [{ PriceAmount: v(net, cur) }],
      ItemPriceExtension: [{ Amount: v(net, cur) }],
    };
  });
  const net = round(input.lines.reduce((s, l) => s + l.gross - l.tax, 0));
  const tax = round(input.lines.reduce((s, l) => s + l.tax, 0));
  const gross = round(net + tax);
  // One subtotal per tax category used.
  const byRate = new Map<number | null, { taxable: number; tax: number }>();
  for (const l of input.lines) {
    const t = byRate.get(l.rate) ?? { taxable: 0, tax: 0 };
    t.taxable += l.gross - l.tax;
    t.tax += l.tax;
    byRate.set(l.rate, t);
  }
  const iso = input.issuedAt.toISOString();
  const buyer = input.buyer ?? GENERAL_PUBLIC;
  const doc = {
    _D: "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2",
    _A: "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2",
    _B: "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
    Invoice: [
      {
        ID: v(input.codeNumber),
        IssueDate: v(iso.slice(0, 10)),
        IssueTime: v(`${iso.slice(11, 19)}Z`),
        InvoiceTypeCode: v(input.typeCode, { listVersionID: "1.0" }),
        DocumentCurrencyCode: v(input.currency),
        TaxCurrencyCode: v(input.currency),
        ...(input.refers
          ? { BillingReference: [{ InvoiceDocumentReference: [{ ID: v(input.refers.codeNumber), UUID: v(input.refers.uuid) }] }] }
          : {}),
        AccountingSupplierParty: [
          {
            Party: [
              {
                IndustryClassificationCode: v(input.supplier.msicCode, { name: input.supplier.msicName }),
                PartyIdentification: partyIds(input.supplier),
                PostalAddress: address(input.supplier),
                PartyLegalEntity: [{ RegistrationName: v(input.supplier.name) }],
                Contact: [{ Telephone: v(input.supplier.phone), ElectronicMail: v(input.supplier.email) }],
              },
            ],
          },
        ],
        AccountingCustomerParty: [
          {
            Party: [
              {
                PostalAddress: address(buyer),
                PartyLegalEntity: [{ RegistrationName: v(buyer.name) }],
                PartyIdentification: partyIds(buyer),
                Contact: [{ Telephone: v(buyer.phone), ElectronicMail: v(buyer.email) }],
              },
            ],
          },
        ],
        TaxTotal: [
          {
            TaxAmount: v(tax, cur),
            TaxSubtotal: [...byRate.entries()].map(([rate, t]) => ({
              TaxableAmount: v(round(t.taxable), cur),
              TaxAmount: v(round(t.tax), cur),
              TaxCategory: taxCategory(rate),
            })),
          },
        ],
        LegalMonetaryTotal: [
          {
            LineExtensionAmount: v(net, cur),
            TaxExclusiveAmount: v(net, cur),
            TaxInclusiveAmount: v(gross, cur),
            PayableAmount: v(gross, cur),
          },
        ],
        InvoiceLine: lines,
      },
    ],
  };
  return { json: JSON.stringify(doc), net, tax, gross };
}

/** As a submission carries it: the document base64, and its SHA-256 in hex. */
export function encodeForSubmission(json: string): { document: string; documentHash: string } {
  return {
    document: Buffer.from(json, "utf8").toString("base64"),
    documentHash: crypto.createHash("sha256").update(json, "utf8").digest("hex"),
  };
}
