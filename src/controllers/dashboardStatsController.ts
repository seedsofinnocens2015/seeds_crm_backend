import { Request, Response } from "express";
import { Lead } from "../models/Lead.js";
import {
  getDashboardCache,
  getLastInvalidationTimestamp,
} from "../utils/cacheInvalidation.js";

const CACHE_TTL_MS = 15000; // 15 seconds fresh cache window

// Helper functions for categorization and date parsing (matching original implementation)
function getMonthFromDate(dateStr: string): string {
  if (!dateStr) return "";
  const match = dateStr.trim().match(/^\d{1,2}-([A-Za-z]{3})-(\d{2,4})$/i);
  if (match) {
    const month = match[1].charAt(0).toUpperCase() + match[1].slice(1, 3).toLowerCase();
    let year = match[2];
    if (year.length === 4) year = year.slice(2);
    return `${month}-${year}`;
  }
  return "";
}

function parseCurrencyNumber(val: any): number {
  if (!val) return 0;
  if (typeof val === "number") return isNaN(val) ? 0 : val;
  const cleaned = String(val).replace(/[^0-9.-]+/g, "");
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

function parseDateToSortKey(dStr: string): number {
  if (!dStr) return 0;
  const match = dStr.trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/i);
  if (match) {
    const day = parseInt(match[1], 10);
    const mStr = match[2].toLowerCase();
    const MONTH_LOOKUP: Record<string, number> = {
      jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
      jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
    };
    const m = MONTH_LOOKUP[mStr] ?? 0;
    let y = parseInt(match[3], 10);
    if (y < 100) y += 2000;
    return new Date(y, m, day).getTime();
  }
  const timestamp = new Date(dStr).getTime();
  return isNaN(timestamp) ? 0 : timestamp;
}

function parseMonthToSortKey(mStr: string): number {
  if (!mStr) return 0;
  const match = mStr.trim().match(/^([A-Za-z]{3})-(\d{2,4})$/i);
  if (match) {
    const mStrPart = match[1].toLowerCase();
    const MONTH_LOOKUP: Record<string, number> = {
      jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
      jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
    };
    const m = MONTH_LOOKUP[mStrPart] ?? 0;
    let y = parseInt(match[2], 10);
    if (y < 100) y += 2000;
    return new Date(y, m, 1).getTime();
  }
  return 0;
}

function categorizeDisposition(raw: string | undefined): "Closed" | "Contact Attempt" | "Contacted" | "Converted" | "Other" {
  if (!raw) return "Other";
  const str = raw.trim().toLowerCase();
  if (str === "closed") return "Closed";
  if (str === "contact attempt" || str.includes("attempt")) return "Contact Attempt";
  if (str === "contacted") return "Contacted";
  if (str === "converted") return "Converted";
  return "Other";
}

function categorizeValidStatus(raw: string | undefined): "Valid" | "Invalid" | "NA" | "Other" {
  if (!raw) return "Other";
  const str = raw.trim().toLowerCase();
  if (str === "valid") return "Valid";
  if (str === "invalid") return "Invalid";
  if (str === "na" || str === "n/a") return "NA";
  return "Other";
}

/**
 * GET /api/v1/dashboard-stats
 * Computes all 12 CRM analytics matrices and KPI summaries.
 * Role-based access:
 * - Admin, Team Leader, MIS, Marketing: access full system statistics.
 * - Agent: strictly scoped to leads assigned to their own callerName.
 *
 * Query Parameters:
 * - month: Filter for FTD, Appointment Date, Surgery Date ("All" or e.g. "Oct-26")
 * - location: Filter for appointments, surgeries, calls, sub-dispositions, sources ("All" or location name)
 * - fresh: Boolean ("true") to bypass the short-term cache
 */
export async function getDashboardStats(req: Request, res: Response) {
  const startTime = Date.now();
  try {
    const session = req.user!;
    const selectedMonth = (req.query.month as string) || "All";
    const selectedLocation = (req.query.location as string) || "All";
    const forceFresh = req.query.fresh === "true";

    const userRole = session.role;
    const userName = (session.name || "").trim();
    const userId = (session.id || "").toString();

    // Cache key incorporates role, user identity, and filter parameters
    const cacheKey = `${userRole}__${userId}__${userName}__${selectedMonth}__${selectedLocation}`;
    const cacheMap = getDashboardCache();
    const cached = cacheMap.get(cacheKey);
    const lastInvalidated = getLastInvalidationTimestamp();
    const now = Date.now();

    if (!forceFresh && cached && now - cached.timestamp < CACHE_TTL_MS && cached.timestamp >= lastInvalidated) {
      res.setHeader("Cache-Control", "no-store, max-age=0");
      res.setHeader("X-Cache", "HIT");
      res.setHeader("X-Response-Time", `${Date.now() - startTime}ms`);
      return res.status(200).json(cached.data);
    }

    // Role-based scoping query
    const query: any = {};
    if (userRole === "agent") {
      query.callerName = {
        $regex: new RegExp(`^${userName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
      };
    }

    // Minimal projection with only the necessary matrix fields (excludes heavy auditLogs and notesHistory)
    const leads = await Lead.find(query)
      .select({
        month: 1,
        date: 1,
        appointmentMonth: 1,
        appointmentDate: 1,
        surgeryMonth: 1,
        surgeryDate: 1,
        location: 1,
        otherCity: 1,
        followUpDate: 1,
        followUpDates: 1,
        dispositions: 1,
        validStatus: 1,
        consultationCharges: 1,
        surgeryPaymentReceived: 1,
        subDispositions: 1,
        leadSource: 1,
      })
      .sort({ createdAt: -1 })
      .lean();

    // 1. Compute Distinct Months & Locations
    const monthSet = new Set<string>();
    const locationSet = new Set<string>();

    leads.forEach((l: any) => {
      let lm = (l.month || "").trim();
      if (!lm && l.date) lm = getMonthFromDate(l.date);
      if (lm) monthSet.add(lm);

      let am = (l.appointmentMonth || "").trim();
      if (!am && l.appointmentDate) am = getMonthFromDate(l.appointmentDate);
      if (am) monthSet.add(am);

      let sm = (l.surgeryMonth || "").trim();
      if (!sm && l.surgeryDate) sm = getMonthFromDate(l.surgeryDate);
      if (sm) monthSet.add(sm);

      const loc = (l.location || l.otherCity || "").trim();
      if (loc) locationSet.add(loc);
    });

    const distinctMonths = Array.from(monthSet).sort(
      (a, b) => parseMonthToSortKey(a) - parseMonthToSortKey(b)
    );
    const distinctLocations = Array.from(locationSet).sort();

    // Filter leads for FTD by selectedMonth
    const filteredLeadsByMonth = selectedMonth === "All"
      ? leads
      : leads.filter((l: any) => {
          let m = (l.month || "").trim();
          if (!m && l.date) m = getMonthFromDate(l.date);
          return m === selectedMonth;
        });

    const isFollowUpLead = (lead: any) => {
      return (
        !!(lead.followUpDate && String(lead.followUpDate).trim()) ||
        !!(lead.followUpDates && String(lead.followUpDates).trim())
      );
    };

    // 2. Compute Overall KPI Metrics (Full Lifetime)
    let closed = 0, contactAttempt = 0, contacted = 0, converted = 0, followUp = 0, other = 0;
    leads.forEach((lead: any) => {
      if (isFollowUpLead(lead)) followUp++;
      const cat = categorizeDisposition(lead.dispositions);
      if (cat === "Closed") closed++;
      else if (cat === "Contact Attempt") contactAttempt++;
      else if (cat === "Contacted") contacted++;
      else if (cat === "Converted") converted++;
      else other++;
    });
    const total = leads.length;
    const conversionRate = total > 0 ? ((converted / total) * 100).toFixed(1) : "0.0";
    const metrics = {
      total,
      closed,
      contactAttempt,
      contacted,
      converted,
      followUp,
      other,
      conversionRate,
    };

    // 3. Lead Summary FTD (Date-wise Pivot Matrix)
    const ftdDateMap: Record<string, any> = {};
    const ftdTotals = {
      other: 0,
      closed: 0,
      contactAttempt: 0,
      contacted: 0,
      converted: 0,
      followUp: 0,
      grandTotal: 0,
    };

    filteredLeadsByMonth.forEach((lead: any) => {
      const d = (lead.date || "Unknown").trim();
      if (!ftdDateMap[d]) {
        ftdDateMap[d] = {
          date: d,
          dateSortKey: parseDateToSortKey(d),
          other: 0,
          closed: 0,
          contactAttempt: 0,
          contacted: 0,
          converted: 0,
          followUp: 0,
          grandTotal: 0,
        };
      }

      if (isFollowUpLead(lead)) {
        ftdDateMap[d].followUp++;
        ftdTotals.followUp++;
      }

      const cat = categorizeDisposition(lead.dispositions);
      if (cat === "Closed") {
        ftdDateMap[d].closed++;
        ftdTotals.closed++;
      } else if (cat === "Contact Attempt") {
        ftdDateMap[d].contactAttempt++;
        ftdTotals.contactAttempt++;
      } else if (cat === "Contacted") {
        ftdDateMap[d].contacted++;
        ftdTotals.contacted++;
      } else if (cat === "Converted") {
        ftdDateMap[d].converted++;
        ftdTotals.converted++;
      } else {
        ftdDateMap[d].other++;
        ftdTotals.other++;
      }

      ftdDateMap[d].grandTotal =
        ftdDateMap[d].closed +
        ftdDateMap[d].contactAttempt +
        ftdDateMap[d].contacted +
        ftdDateMap[d].converted +
        ftdDateMap[d].other;
    });

    ftdTotals.grandTotal =
      ftdTotals.closed +
      ftdTotals.contactAttempt +
      ftdTotals.contacted +
      ftdTotals.converted +
      ftdTotals.other;

    const ftdRows = Object.values(ftdDateMap).sort((a, b) => a.dateSortKey - b.dateSortKey);
    const ftdData = { rows: ftdRows, totals: ftdTotals };

    // 4. Lead Summary MTD (Month-wise Pivot Matrix)
    const mtdMonthMap: Record<string, any> = {};
    const mtdTotals = {
      other: 0,
      closed: 0,
      contactAttempt: 0,
      contacted: 0,
      converted: 0,
      followUp: 0,
      grandTotal: 0,
    };

    leads.forEach((lead: any) => {
      let m = (lead.month || "").trim();
      if (!m && lead.date) m = getMonthFromDate(lead.date);
      const monthKey = m || "Unknown";

      if (!mtdMonthMap[monthKey]) {
        mtdMonthMap[monthKey] = {
          month: monthKey,
          monthSortKey: parseMonthToSortKey(monthKey),
          other: 0,
          closed: 0,
          contactAttempt: 0,
          contacted: 0,
          converted: 0,
          followUp: 0,
          grandTotal: 0,
        };
      }

      if (isFollowUpLead(lead)) {
        mtdMonthMap[monthKey].followUp++;
        mtdTotals.followUp++;
      }

      const cat = categorizeDisposition(lead.dispositions);
      if (cat === "Closed") {
        mtdMonthMap[monthKey].closed++;
        mtdTotals.closed++;
      } else if (cat === "Contact Attempt") {
        mtdMonthMap[monthKey].contactAttempt++;
        mtdTotals.contactAttempt++;
      } else if (cat === "Contacted") {
        mtdMonthMap[monthKey].contacted++;
        mtdTotals.contacted++;
      } else if (cat === "Converted") {
        mtdMonthMap[monthKey].converted++;
        mtdTotals.converted++;
      } else {
        mtdMonthMap[monthKey].other++;
        mtdTotals.other++;
      }

      mtdMonthMap[monthKey].grandTotal =
        mtdMonthMap[monthKey].closed +
        mtdMonthMap[monthKey].contactAttempt +
        mtdMonthMap[monthKey].contacted +
        mtdMonthMap[monthKey].converted +
        mtdMonthMap[monthKey].other;
    });

    mtdTotals.grandTotal =
      mtdTotals.closed +
      mtdTotals.contactAttempt +
      mtdTotals.contacted +
      mtdTotals.converted +
      mtdTotals.other;

    const mtdRows = Object.values(mtdMonthMap).sort((a, b) => a.monthSortKey - b.monthSortKey);
    const mtdData = { rows: mtdRows, totals: mtdTotals };

    // 5. Valid Summary (Month-wise Valid Status Matrix)
    const validMonthMap: Record<string, any> = {};
    const validTotals = {
      other: 0,
      invalid: 0,
      na: 0,
      valid: 0,
      grandTotal: 0,
      validPercent: "0.00%",
    };

    leads.forEach((lead: any) => {
      let m = (lead.month || "").trim();
      if (!m && lead.date) m = getMonthFromDate(lead.date);
      const monthKey = m || "Unknown";

      if (!validMonthMap[monthKey]) {
        validMonthMap[monthKey] = {
          month: monthKey,
          monthSortKey: parseMonthToSortKey(monthKey),
          other: 0,
          invalid: 0,
          na: 0,
          valid: 0,
          grandTotal: 0,
        };
      }

      const status = categorizeValidStatus(lead.validStatus);
      if (status === "Invalid") {
        validMonthMap[monthKey].invalid++;
        validTotals.invalid++;
      } else if (status === "NA") {
        validMonthMap[monthKey].na++;
        validTotals.na++;
      } else if (status === "Valid") {
        validMonthMap[monthKey].valid++;
        validTotals.valid++;
      } else {
        validMonthMap[monthKey].other++;
        validTotals.other++;
      }

      validMonthMap[monthKey].grandTotal =
        validMonthMap[monthKey].invalid +
        validMonthMap[monthKey].na +
        validMonthMap[monthKey].valid;
    });

    const validGrandTotalSum = validTotals.invalid + validTotals.na + validTotals.valid;
    validTotals.grandTotal = validGrandTotalSum;
    validTotals.validPercent =
      validGrandTotalSum > 0
        ? ((validTotals.valid / validGrandTotalSum) * 100).toFixed(2) + "%"
        : "0.00%";

    const validRows = Object.values(validMonthMap)
      .sort((a, b) => a.monthSortKey - b.monthSortKey)
      .map((r: any) => ({
        ...r,
        validPercent:
          r.grandTotal > 0 ? ((r.valid / r.grandTotal) * 100).toFixed(2) + "%" : "0.00%",
      }));

    const validSummaryData = { rows: validRows, totals: validTotals };

    // 6. Appointment Date Summary
    const apptDateMap: Record<string, any> = {};
    let totalApptCount = 0;
    let totalApptCollections = 0;

    let apptSourceLeads = selectedMonth === "All"
      ? leads
      : leads.filter((l: any) => {
          let m = (l.appointmentMonth || "").trim();
          if (!m && l.appointmentDate) m = getMonthFromDate(l.appointmentDate);
          return m === selectedMonth;
        });

    if (selectedLocation !== "All") {
      apptSourceLeads = apptSourceLeads.filter(
        (l: any) => (l.location || l.otherCity || "") === selectedLocation
      );
    }

    apptSourceLeads.forEach((lead: any) => {
      const d = (lead.appointmentDate || "").trim();
      const charges = parseCurrencyNumber(lead.consultationCharges);
      const hasAppt = !!lead.appointmentDate || charges > 0;

      if (hasAppt) {
        const dateKey = d || "Unknown";
        const loc = (lead.location || lead.otherCity || "Unspecified").trim();
        const groupKey = `${dateKey}___${loc}`;

        if (!apptDateMap[groupKey]) {
          apptDateMap[groupKey] = {
            date: dateKey,
            location: loc,
            dateSortKey: parseDateToSortKey(dateKey),
            count: 0,
            collections: 0,
          };
        }

        apptDateMap[groupKey].count += 1;
        apptDateMap[groupKey].collections += charges;
        totalApptCount += 1;
        totalApptCollections += charges;
      }
    });

    const appointmentDateData = {
      rows: Object.values(apptDateMap).sort((a, b) => a.dateSortKey - b.dateSortKey),
      totals: { count: totalApptCount, collections: totalApptCollections },
    };

    // 7. Appointment Month Summary
    const apptMonthMap: Record<string, any> = {};
    let totalApptMonthCount = 0;
    let totalApptMonthCollections = 0;

    let apptMonthSourceLeads = leads;
    if (selectedLocation !== "All") {
      apptMonthSourceLeads = apptMonthSourceLeads.filter(
        (l: any) => (l.location || l.otherCity || "") === selectedLocation
      );
    }

    apptMonthSourceLeads.forEach((lead: any) => {
      let m = (lead.appointmentMonth || "").trim();
      if (!m && lead.appointmentDate) m = getMonthFromDate(lead.appointmentDate);
      const charges = parseCurrencyNumber(lead.consultationCharges);
      const hasAppt = !!lead.appointmentDate || !!lead.appointmentMonth || charges > 0;

      if (hasAppt) {
        const monthKey = m || "Unknown";
        if (!apptMonthMap[monthKey]) {
          apptMonthMap[monthKey] = {
            month: monthKey,
            monthSortKey: parseMonthToSortKey(monthKey),
            count: 0,
            collections: 0,
          };
        }
        apptMonthMap[monthKey].count += 1;
        apptMonthMap[monthKey].collections += charges;
        totalApptMonthCount += 1;
        totalApptMonthCollections += charges;
      }
    });

    const appointmentMonthData = {
      rows: Object.values(apptMonthMap).sort((a, b) => a.monthSortKey - b.monthSortKey),
      totals: { count: totalApptMonthCount, collections: totalApptMonthCollections },
    };

    // 8. Surgery Month Summary
    const surgMonthMap: Record<string, any> = {};
    let totalSurgMonthCount = 0;
    let totalSurgMonthPayments = 0;

    let surgMonthSourceLeads = leads;
    if (selectedLocation !== "All") {
      surgMonthSourceLeads = surgMonthSourceLeads.filter(
        (l: any) => (l.location || l.otherCity || "") === selectedLocation
      );
    }

    surgMonthSourceLeads.forEach((lead: any) => {
      const d = (lead.surgeryDate || "").trim();
      if (!d) return;

      const payment = parseCurrencyNumber(lead.surgeryPaymentReceived);
      let m = (lead.surgeryMonth || "").trim();
      if (!m) m = getMonthFromDate(d);
      const monthKey = m || "Unknown";

      if (!surgMonthMap[monthKey]) {
        surgMonthMap[monthKey] = {
          month: monthKey,
          monthSortKey: parseMonthToSortKey(monthKey),
          count: 0,
          paymentReceived: 0,
        };
      }

      surgMonthMap[monthKey].count += 1;
      surgMonthMap[monthKey].paymentReceived += payment;
      totalSurgMonthCount += 1;
      totalSurgMonthPayments += payment;
    });

    const surgeryMonthData = {
      rows: Object.values(surgMonthMap).sort((a, b) => a.monthSortKey - b.monthSortKey),
      totals: { count: totalSurgMonthCount, paymentReceived: totalSurgMonthPayments },
    };

    // 9. Surgery Date Summary
    const surgDateMap: Record<string, any> = {};
    let totalSurgDateCount = 0;
    let totalSurgDatePayments = 0;

    let surgDateSourceLeads = selectedMonth === "All"
      ? leads
      : leads.filter((l: any) => {
          if (!l.surgeryDate) return false;
          let m = (l.surgeryMonth || "").trim();
          if (!m) m = getMonthFromDate(l.surgeryDate);
          return m === selectedMonth;
        });

    if (selectedLocation !== "All") {
      surgDateSourceLeads = surgDateSourceLeads.filter(
        (l: any) => (l.location || l.otherCity || "") === selectedLocation
      );
    }

    surgDateSourceLeads.forEach((lead: any) => {
      const d = (lead.surgeryDate || "").trim();
      if (!d) return;

      const payment = parseCurrencyNumber(lead.surgeryPaymentReceived);
      const dateKey = d;
      const loc = (lead.location || lead.otherCity || "Unspecified").trim();
      const groupKey = `${dateKey}___${loc}`;

      if (!surgDateMap[groupKey]) {
        surgDateMap[groupKey] = {
          date: dateKey,
          location: loc,
          dateSortKey: parseDateToSortKey(dateKey),
          count: 0,
          paymentReceived: 0,
        };
      }

      surgDateMap[groupKey].count += 1;
      surgDateMap[groupKey].paymentReceived += payment;
      totalSurgDateCount += 1;
      totalSurgDatePayments += payment;
    });

    const surgeryDateData = {
      rows: Object.values(surgDateMap).sort((a, b) => a.dateSortKey - b.dateSortKey),
      totals: { count: totalSurgDateCount, paymentReceived: totalSurgDatePayments },
    };

    // 10. Call Summary
    const callMonthMap: Record<string, any> = {};
    let totalEnquiry = 0;
    let totalValid = 0;
    let totalConverted = 0;
    let totalConsultationCharges = 0;
    let totalSurgeryCount = 0;
    let totalSurgeryCollections = 0;

    let callSourceLeads = leads;
    if (selectedLocation !== "All") {
      callSourceLeads = callSourceLeads.filter(
        (l: any) => (l.location || l.otherCity || "") === selectedLocation
      );
    }

    callSourceLeads.forEach((lead: any) => {
      let m = (lead.month || "").trim();
      if (!m && lead.date) m = getMonthFromDate(lead.date);
      const monthKey = m || "Unknown";

      if (!callMonthMap[monthKey]) {
        callMonthMap[monthKey] = {
          month: monthKey,
          monthSortKey: parseMonthToSortKey(monthKey),
          enquiry: 0,
          valid: 0,
          converted: 0,
          consultationCharges: 0,
          surgeryCount: 0,
          surgeryCollections: 0,
          totalCollections: 0,
        };
      }

      callMonthMap[monthKey].enquiry += 1;
      totalEnquiry += 1;

      const validCat = categorizeValidStatus(lead.validStatus);
      if (validCat === "Valid") {
        callMonthMap[monthKey].valid += 1;
        totalValid += 1;
      }

      const dispCat = categorizeDisposition(lead.dispositions);
      if (dispCat === "Converted") {
        callMonthMap[monthKey].converted += 1;
        totalConverted += 1;
      }

      const consultFee = parseCurrencyNumber(lead.consultationCharges);
      if (consultFee > 0) {
        callMonthMap[monthKey].consultationCharges += consultFee;
        totalConsultationCharges += consultFee;
      }

      const surgPay = parseCurrencyNumber(lead.surgeryPaymentReceived);
      const hasSurgery = !!(lead.surgeryDate && String(lead.surgeryDate).trim());
      if (hasSurgery) {
        callMonthMap[monthKey].surgeryCount += 1;
        totalSurgeryCount += 1;
        callMonthMap[monthKey].surgeryCollections += surgPay;
        totalSurgeryCollections += surgPay;
      }
    });

    const callRows = Object.values(callMonthMap)
      .sort((a, b) => a.monthSortKey - b.monthSortKey)
      .map((r: any) => {
        const totalColl = r.consultationCharges + r.surgeryCollections;
        return {
          ...r,
          totalCollections: totalColl,
          enqToValidPct:
            r.enquiry > 0 ? ((r.valid / r.enquiry) * 100).toFixed(2) + "%" : "0.00%",
          validToConPct:
            r.valid > 0 ? ((r.converted / r.valid) * 100).toFixed(2) + "%" : "0.00%",
          enqToConPct:
            r.enquiry > 0 ? ((r.converted / r.enquiry) * 100).toFixed(2) + "%" : "0.00%",
        };
      });

    const grandTotalCollections = totalConsultationCharges + totalSurgeryCollections;
    const callSummaryData = {
      rows: callRows,
      totals: {
        enquiry: totalEnquiry,
        valid: totalValid,
        converted: totalConverted,
        enqToValidPct:
          totalEnquiry > 0 ? ((totalValid / totalEnquiry) * 100).toFixed(2) + "%" : "0.00%",
        validToConPct:
          totalValid > 0 ? ((totalConverted / totalValid) * 100).toFixed(2) + "%" : "0.00%",
        enqToConPct:
          totalEnquiry > 0 ? ((totalConverted / totalEnquiry) * 100).toFixed(2) + "%" : "0.00%",
        consultationCharges: totalConsultationCharges,
        surgeryCount: totalSurgeryCount,
        surgeryCollections: totalSurgeryCollections,
        totalCollections: grandTotalCollections,
      },
    };

    // 11. Sub-Disposition Summary (Hierarchical Pivot Matrix)
    let subDispSourceLeads = leads;
    if (selectedLocation !== "All") {
      subDispSourceLeads = subDispSourceLeads.filter(
        (l: any) => (l.location || l.otherCity || "") === selectedLocation
      );
    }

    const subDispMonthSet = new Set<string>();
    subDispSourceLeads.forEach((lead: any) => {
      let m = (lead.month || "").trim();
      if (!m && lead.date) m = getMonthFromDate(lead.date);
      if (m) subDispMonthSet.add(m);
    });
    const subDispMonths = Array.from(subDispMonthSet).sort(
      (a, b) => parseMonthToSortKey(a) - parseMonthToSortKey(b)
    );

    const subDispMatrix: Record<string, Record<string, Record<string, number>>> = {};
    const subDispDispositionTotals: Record<string, Record<string, number>> = {};
    const subDispGrandTotals: Record<string, number> = {};
    subDispMonths.forEach((m) => {
      subDispGrandTotals[m] = 0;
    });
    let subDispOverallGrandTotal = 0;

    subDispSourceLeads.forEach((lead: any) => {
      const rawDisp = (lead.dispositions || "").trim();
      const rawSub = (lead.subDispositions || "").trim() || "Unspecified";
      let m = (lead.month || "").trim();
      if (!m && lead.date) m = getMonthFromDate(lead.date);
      const monthKey = m || "Unknown";

      const dispCat = rawDisp ? categorizeDisposition(rawDisp) : "";

      if (!subDispMatrix[dispCat]) {
        subDispMatrix[dispCat] = {};
        subDispDispositionTotals[dispCat] = {};
        subDispMonths.forEach((mon) => {
          subDispDispositionTotals[dispCat][mon] = 0;
        });
      }

      if (!subDispMatrix[dispCat][rawSub]) {
        subDispMatrix[dispCat][rawSub] = {};
        subDispMonths.forEach((mon) => {
          subDispMatrix[dispCat][rawSub][mon] = 0;
        });
      }

      subDispMatrix[dispCat][rawSub][monthKey] =
        (subDispMatrix[dispCat][rawSub][monthKey] || 0) + 1;
      subDispDispositionTotals[dispCat][monthKey] =
        (subDispDispositionTotals[dispCat][monthKey] || 0) + 1;
      subDispGrandTotals[monthKey] = (subDispGrandTotals[monthKey] || 0) + 1;
      subDispOverallGrandTotal += 1;
    });

    const orderedDispositions = [
      "",
      "Closed",
      "Contact Attempt",
      "Contacted",
      "Converted",
      "Other",
    ].filter((d) => subDispMatrix[d] && Object.keys(subDispMatrix[d]).length > 0);

    Object.keys(subDispMatrix).forEach((d) => {
      if (!orderedDispositions.includes(d)) orderedDispositions.push(d);
    });

    const subDispGroups = orderedDispositions.map((dispName) => {
      const subDisps = subDispMatrix[dispName];
      const sortedSubNames = Object.keys(subDisps).sort((a, b) => a.localeCompare(b));

      const rows = sortedSubNames.map((subName) => {
        const monthCounts = subDisps[subName];
        let subTotal = 0;
        subDispMonths.forEach((m) => {
          subTotal += monthCounts[m] || 0;
        });
        return {
          subDisposition: subName,
          monthCounts,
          total: subTotal,
        };
      });

      const totalsByMonth = subDispDispositionTotals[dispName] || {};
      let groupTotal = 0;
      subDispMonths.forEach((m) => {
        groupTotal += totalsByMonth[m] || 0;
      });

      return {
        disposition: dispName,
        label: dispName ? `${dispName} Total` : "Total",
        rows,
        totalsByMonth,
        groupTotal,
      };
    });

    const subDispData = {
      months: subDispMonths,
      groups: subDispGroups,
      grandTotals: subDispGrandTotals,
      overallGrandTotal: subDispOverallGrandTotal,
    };

    // 12. Lead Source Summary (Month-wise Lead Source Count)
    let leadSrcSourceLeads = leads;
    if (selectedLocation !== "All") {
      leadSrcSourceLeads = leadSrcSourceLeads.filter(
        (l: any) => (l.location || l.otherCity || "") === selectedLocation
      );
    }

    const leadSrcMonthMap: Record<string, Record<string, number>> = {};
    const leadSrcMonthTotals: Record<string, number> = {};
    let leadSrcGrandTotalCount = 0;

    leadSrcSourceLeads.forEach((lead: any) => {
      let m = (lead.month || "").trim();
      if (!m && lead.date) m = getMonthFromDate(lead.date);
      const monthKey = m || "Unknown";
      const src = (lead.leadSource || "").trim() || "Unspecified";

      if (!leadSrcMonthMap[monthKey]) {
        leadSrcMonthMap[monthKey] = {};
        leadSrcMonthTotals[monthKey] = 0;
      }

      leadSrcMonthMap[monthKey][src] = (leadSrcMonthMap[monthKey][src] || 0) + 1;
      leadSrcMonthTotals[monthKey] = (leadSrcMonthTotals[monthKey] || 0) + 1;
      leadSrcGrandTotalCount += 1;
    });

    const sortedLeadSrcMonths = Object.keys(leadSrcMonthMap).sort(
      (a, b) => parseMonthToSortKey(a) - parseMonthToSortKey(b)
    );

    const leadSrcGroups = sortedLeadSrcMonths.map((m) => {
      const srcObj = leadSrcMonthMap[m];
      const sortedSources = Object.keys(srcObj).sort((a, b) => a.localeCompare(b));
      const rows = sortedSources.map((srcName) => ({
        source: srcName,
        count: srcObj[srcName],
      }));

      return {
        month: m,
        rows,
        total: leadSrcMonthTotals[m] || 0,
      };
    });

    const leadSourceData = {
      groups: leadSrcGroups,
      grandTotal: leadSrcGrandTotalCount,
    };

    const payload = {
      distinctMonths,
      distinctLocations,
      metrics,
      ftdData,
      mtdData,
      validSummaryData,
      appointmentDateData,
      appointmentMonthData,
      surgeryDateData,
      surgeryMonthData,
      callSummaryData,
      subDispData,
      leadSourceData,
    };

    // Store in short-term cache
    getDashboardCache().set(cacheKey, { data: payload, timestamp: now });

    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("X-Cache", "MISS");
    res.setHeader("X-Response-Time", `${Date.now() - startTime}ms`);
    return res.status(200).json(payload);
  } catch (error: any) {
    console.error("Dashboard statistics API error:", error);
    return res.status(500).json({
      error: error.message || "Failed to load dashboard statistics",
    });
  }
}
