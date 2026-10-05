/**
 * The privacy policy and terms of use, in English: the public site's own
 * texts (webyar.ai/privacy, webyar.ai/terms), translated from the Persian
 * with the same effective date, sections and contact address.
 *
 * Served by the app itself at /privacy and /terms so the iPhone and Android
 * apps, and their store records, can link to a page on the platform's own
 * domain. A change here is a change to a legal text: make it on the site too,
 * and move the effective date.
 */

export type LegalDocumentId = 'privacy' | 'terms';

export interface LegalSection {
  heading: string;
  /** `{email}` stands for the contact address, drawn as a mail link. */
  paragraphs: string[];
}

export interface LegalDocument {
  /** The browser tab's title. */
  pageTitle: string;
  title: string;
  /** The line under the title: when it took effect, and whose it is. */
  effective: string;
  sections: LegalSection[];
}

export const LEGAL_CONTACT_EMAIL = 'info@webyar.ai';

export const LEGAL_CHROME = {
  brand: 'Webyar',
  copyright: '© 2026 Webyar — All rights reserved.',
  privacy: 'Privacy',
  terms: 'Terms of Use',
};

const PRIVACY: LegalDocument = {
  pageTitle: 'Privacy Policy | Webyar',
  title: 'Privacy Policy',
  effective: 'Effective date: September 1, 2026 · Webyar',
  sections: [
    {
      heading: '1. Introduction',
      paragraphs: [
        'This Privacy Policy explains how Webyar collects, uses, discloses, stores and protects personal information when you use its website, applications and related services (the “Services”).',
        'By using the Services, you accept this policy. If you do not agree with it, please do not use the Services.',
      ],
    },
    {
      heading: '2. Information we collect',
      paragraphs: [
        'Account information: your name, email address, phone number (if provided) and a hashed value of your password for signing in.',
        'Content information: messages, tickets, files, contacts and other content that you or your users record in the Services.',
        'Usage information: pages visited, features used, approximate location based on IP address, device type, operating system, browser and error reports.',
        'Transaction information: subscription plan, billing status and invoice records. Full card numbers are never stored by us; they are handled by the payment gateway.',
      ],
    },
    {
      heading: '3. How we use information',
      paragraphs: [
        'To create and maintain your account and to authenticate you.',
        'To provide, operate, support, secure and improve the Services.',
        'To inform you about updates, security alerts and support requests.',
        'To detect, prevent and investigate fraud, abuse and violations of the terms of use.',
        'To comply with legal requirements.',
      ],
    },
    {
      heading: '4. Legal bases for processing',
      paragraphs: [
        'Where the law requires it, data is processed on the basis of performing a contract (providing the service you asked for), legitimate interests (security and product improvement), your consent (optional communications) and legal obligations.',
      ],
    },
    {
      heading: '5. Sharing and disclosure',
      paragraphs: [
        'We do not sell your personal information and do not make it available to others for third-party advertising.',
        'Data is shared only with service providers that work on our behalf (hosting, storage, email delivery, analytics and payments) under confidentiality obligations, or where the law requires it.',
      ],
    },
    {
      heading: '6. Children’s privacy',
      paragraphs: [
        'The Services are not designed for children under 13, and we do not knowingly collect their information. If you believe a child has submitted information, contact us so that we can delete it.',
      ],
    },
    {
      heading: '7. Data security',
      paragraphs: [
        'We use encryption in transit (TLS), password hashing, access control, event logging and regular backups. No method of transmission or storage is completely secure, but if a breach occurs we will notify you as the law requires.',
      ],
    },
    {
      heading: '8. Data retention',
      paragraphs: [
        'Personal information is kept for as long as your account is active and it is needed to provide the Services. After an account is deleted, its personal data is deleted or anonymized within 30 days at most, unless longer retention is needed for legal, accounting or security reasons.',
      ],
    },
    {
      heading: '9. Your rights and account deletion',
      paragraphs: [
        'You can at any time request access to, correction of, an export of or deletion of your personal information, object to particular processing, or withdraw your consent.',
        'To delete your account and all personal information associated with it, send a message with the subject “Account deletion request” to {email} from the email address registered on the account. Verified requests are completed within 30 days.',
      ],
    },
    {
      heading: '10. Cookies and similar technologies',
      paragraphs: [
        'We use essential cookies to keep you signed in and to secure the Services, and optional analytics cookies to understand how they are used. You can manage cookies in your browser’s settings; disabling essential cookies disrupts parts of the Services.',
      ],
    },
    {
      heading: '11. International data transfers',
      paragraphs: [
        'Your data may be processed on servers outside your country of residence. In those cases, the necessary safeguards are applied in accordance with data protection laws.',
      ],
    },
    {
      heading: '12. Changes to this policy',
      paragraphs: [
        'We may update this policy. Significant changes are announced on this page with a new effective date and, where necessary, by email or in-app notification.',
      ],
    },
    {
      heading: '13. Contact us',
      paragraphs: [
        'Questions, privacy requests or complaints: {email}',
        'We respond to privacy requests within 30 days at most.',
      ],
    },
  ],
};

const TERMS: LegalDocument = {
  pageTitle: 'Terms of Use | Webyar',
  title: 'Terms of Use',
  effective: 'Effective date: September 1, 2026 · Webyar',
  sections: [
    {
      heading: '1. Acceptance of the terms',
      paragraphs: [
        'These Terms of Use are a binding agreement between you and Webyar about the use of its website, applications and related services (the “Services”). By creating an account or using the Services, you accept these terms.',
      ],
    },
    {
      heading: '2. Eligibility',
      paragraphs: [
        'To use the Services you must be at least 13 years old and legally able to enter into a contract. If you use them on behalf of an organization, you confirm that you have the authority to do so.',
      ],
    },
    {
      heading: '3. Account and security',
      paragraphs: [
        'You are responsible for the accuracy of your registration details, for keeping your sign-in details confidential and for all activity carried out with your account. If you notice unauthorized access, tell us immediately at the contact address below.',
      ],
    },
    {
      heading: '4. Acceptable use',
      paragraphs: [
        'You agree not to: break the law; send spam, malware or unsolicited bulk messages; harass others; upload illegal, infringing, hateful or obscene content; access other users’ data; reverse engineer, scrape or overload the Services; or resell them without written permission.',
        'Accounts that violate this section may be suspended or deleted.',
      ],
    },
    {
      heading: '5. User content',
      paragraphs: [
        'You keep ownership of the content you record. You grant us a limited, non-exclusive license to host, process, transmit and display that content solely to operate and support the Services.',
        'You are responsible for your content and for holding the rights needed to publish it.',
      ],
    },
    {
      heading: '6. Subscriptions, billing and cancellation',
      paragraphs: [
        'Paid plans are billed periodically in advance and renew automatically until cancelled. You can cancel at any time from your account settings or by contacting support; cancellation takes effect at the end of the current period.',
        'Purchases made through Apple’s App Store or Google Play are billed by that store and are subject to its renewal and refund rules.',
      ],
    },
    {
      heading: '7. Third-party services',
      paragraphs: [
        'The Services may integrate with third-party platforms and add-ons. Those services are subject to their own terms and privacy policies, and we are not responsible for their availability or performance.',
      ],
    },
    {
      heading: '8. Intellectual property',
      paragraphs: [
        'All software, designs, trademarks and content provided by Webyar belong to us or our licensors and are protected by intellectual property laws. Except as expressly stated in these terms, no rights are granted.',
      ],
    },
    {
      heading: '9. Service availability',
      paragraphs: [
        'We work to keep the Services available and stable at all times, but they are provided “as is” and, to the extent the law allows, without warranty. Planned maintenance is announced in advance where possible.',
      ],
    },
    {
      heading: '10. Limitation of liability',
      paragraphs: [
        'To the fullest extent permitted by law, Webyar is not liable for indirect or consequential damages or for lost profits or data. Our total liability for any claim is limited to the amount you paid for the Services in the twelve months before that claim.',
      ],
    },
    {
      heading: '11. Termination',
      paragraphs: [
        'You can stop using the Services and delete your account at any time. We may suspend or end access in case of a breach of these terms, a legal requirement or prolonged inactivity, and will give notice in advance where possible.',
      ],
    },
    {
      heading: '12. Changes to these terms',
      paragraphs: [
        'We may update these terms. Significant changes are announced on this page with a new effective date and, where necessary, by email or in-app notification. Continuing to use the Services means accepting the changes.',
      ],
    },
    {
      heading: '13. Governing law',
      paragraphs: [
        'These terms are governed by the laws of our principal place of business. Mandatory consumer protections in your country of residence continue to apply.',
      ],
    },
    {
      heading: '14. Contact',
      paragraphs: ['For questions about these terms, contact {email}.'],
    },
  ],
};

export const LEGAL_DOCUMENTS: Record<LegalDocumentId, LegalDocument> = {
  privacy: PRIVACY,
  terms: TERMS,
};
