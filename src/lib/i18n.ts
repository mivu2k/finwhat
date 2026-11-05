import { I18nManager, Platform } from 'react-native';
import { useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type Lang = 'en' | 'ur';

const ur: Record<string, string> = {
  'Channels': 'چینلز', 'Search': 'تلاش', 'Dashboard': 'ڈیش بورڈ', 'Alerts': 'اطلاعات', 'Profile': 'پروفائل',
  'Sign in': 'سائن ان', 'Create account': 'اکاؤنٹ بنائیں', 'I have an account': 'میرا اکاؤنٹ ہے', 'Create an account': 'نیا اکاؤنٹ',
  'Email': 'ای میل', 'Password': 'پاس ورڈ', 'Full name': 'پورا نام', 'Record expenses like chat messages.': 'اخراجات چیٹ کی طرح درج کریں۔',
  'New channel': 'نیا چینل', 'Add': 'شامل کریں', 'New workspace': 'نیا ورک اسپیس', 'Create workspace': 'ورک اسپیس بنائیں',
  'Approval required': 'منظوری ضروری', 'Auto-approve': 'خودکار منظوری', 'Members': 'اراکین', 'Settings': 'ترتیبات',
  'Form': 'فارم', 'Voice': 'آواز', 'Photo': 'تصویر', 'No expenses yet.': 'ابھی کوئی خرچ نہیں۔',
  'What was it for?': 'کس لیے تھا؟', 'Amount': 'رقم', 'Currency': 'کرنسی', 'Date (YYYY-MM-DD)': 'تاریخ (YYYY-MM-DD)',
  'Vendor / payee': 'دکاندار / وصول کنندہ', 'Category': 'زمرہ', 'Payment method': 'ادائیگی کا طریقہ',
  'Project / cost-center tag': 'پروجیکٹ ٹیگ', 'Notes': 'نوٹس', 'Due date (optional)': 'آخری تاریخ (اختیاری)',
  'Create & submit': 'بنائیں اور جمع کرائیں', 'Save changes': 'تبدیلیاں محفوظ کریں', 'Save draft': 'ڈرافٹ محفوظ کریں',
  'Submit': 'جمع کرائیں', 'Start review': 'جائزہ شروع', 'Approve': 'منظور', 'Reject': 'مسترد', 'Ask for info': 'معلومات طلب',
  'Mark unpaid': 'غیر ادا شدہ', 'Mark paid': 'ادا شدہ', 'Close': 'بند کریں', 'Reopen': 'دوبارہ کھولیں', 'Edit': 'ترمیم',
  'Cancel edit': 'ترمیم منسوخ', 'Convert to form': 'فارم میں تبدیل کریں', 'Send': 'بھیجیں', 'Record payment': 'ادائیگی درج کریں',
  'Comment (also used as status-change note)': 'تبصرہ (اسٹیٹس نوٹ کے طور پر بھی)', 'Reply': 'جواب',
  'Draft': 'ڈرافٹ', 'Submitted': 'جمع شدہ', 'Under review': 'زیر جائزہ', 'Approved': 'منظور شدہ', 'Rejected': 'مسترد',
  'Needs info': 'معلومات درکار', 'Unpaid': 'غیر ادا شدہ', 'Paid': 'ادا شدہ', 'Closed': 'بند',
  'Total spent': 'کل خرچ', 'Pending approval': 'منظوری باقی', 'Pending / unpaid': 'باقی / غیر ادا شدہ',
  'By category': 'زمرے کے لحاظ سے', 'By member': 'رکن کے لحاظ سے', 'By month': 'ماہانہ', 'Export': 'برآمد', 'Receipts': 'رسیدیں',
  'From': 'سے', 'To': 'تک', 'Ledger': 'کھاتہ', 'Mark all read': 'سب پڑھ لیا', 'No notifications.': 'کوئی اطلاع نہیں۔',
  'My unpaid': 'میرے غیر ادا شدہ', 'Awaiting my approval': 'میری منظوری کے منتظر', 'Closed this month': 'اس ماہ بند',
  'Overdue': 'تاخیر شدہ', 'My drafts': 'میرے ڈرافٹ', 'Search vendors, notes, transcripts': 'دکاندار، نوٹس، ٹرانسکرپٹ تلاش کریں',
  'Language': 'زبان', 'Default currency (ISO code)': 'ڈیفالٹ کرنسی', 'Save': 'محفوظ کریں', 'Sign out': 'سائن آؤٹ',
  'Saved': 'محفوظ ہو گیا', 'Error': 'خرابی', 'Audit log': 'آڈٹ لاگ', 'Possible duplicate': 'ممکنہ ڈپلیکیٹ',
  'Submit anyway': 'پھر بھی جمع کرائیں', 'Cancel': 'منسوخ', 'Start recording': 'ریکارڈنگ شروع کریں', 'Stop & send': 'روکیں اور بھیجیں',
  'Recording…': 'ریکارڈنگ…', 'Camera': 'کیمرہ', 'Gallery': 'گیلری', 'PDF / file': 'پی ڈی ایف / فائل',
  'Offline: will sync when back online': 'آف لائن: انٹرنیٹ آنے پر بھیجا جائے گا', 'Exchange rate to': 'شرح تبادلہ بنام',
  'Low confidence: please check': 'کم یقین: براہ کرم چیک کریں', 'Paid so far': 'اب تک ادا', 'Reference no.': 'حوالہ نمبر',
  'Owner approval needed above (blank = never)': 'اس رقم سے اوپر مالک کی منظوری (خالی = کبھی نہیں)',
  'Channel name': 'چینل کا نام', 'Add member by email': 'ای میل سے رکن شامل کریں', 'Remove': 'ہٹائیں',
};

let lang: Lang = 'en';
const listeners = new Set<() => void>();
export const getLang = () => lang;
export function setLang(l: Lang) {
  lang = l;
  AsyncStorage.setItem('expensechat.lang', l).catch(() => {});
  const rtl = l === 'ur';
  if (Platform.OS === 'web') document.documentElement.dir = rtl ? 'rtl' : 'ltr';
  else if (I18nManager.isRTL !== rtl) { I18nManager.allowRTL(rtl); I18nManager.forceRTL(rtl); } // native applies after app restart
  listeners.forEach(f => f());
}
AsyncStorage.getItem('expensechat.lang').then(l => { if (l === 'ur' || l === 'en') setLang(l); }).catch(() => {});

/** Translate; unknown keys fall back to English. Re-renders callers on language change. */
export function useT() {
  useSyncExternalStore(cb => { listeners.add(cb); return () => listeners.delete(cb); }, getLang, getLang);
  return (s: string) => (lang === 'ur' ? ur[s] ?? s : s);
}
