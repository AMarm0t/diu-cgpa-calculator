// Builds the student's transcript as a PDF in the browser and downloads it. The layout follows the
// DIU transcript format: university header, student details, academic summary, the UGC grading
// table, then one table per semester. jsPDF is only loaded when a student asks for the file.

import type { jsPDF } from "jspdf";

export interface TranscriptCourse {
  code: string;
  name: string;
  credits: number;
  grade: string;
  grade_point: number;
}

export interface TranscriptSemester {
  name: string;
  gpa: number;
  courses: TranscriptCourse[];
}

export interface TranscriptData {
  student: {
    name: string;
    id: string;
    department: string;
    batch?: string;
    program?: string;
  };
  overall_cgpa: number;
  total_completed_credits: number;
  semesters: TranscriptSemester[];
}

// Page geometry in points (A4). Sizes and spacing mirror the reference transcript.
const MARGIN = 28.5;
const BLACK = 0;
const HEADER_FILL: [number, number, number] = [240, 240, 240];
const BORDER = 0.75;
// Table rows are 12pt per line of 8.25pt text, as in the reference
const LINE_HEIGHT_FACTOR = 12 / 8.25;
// Distance from the top of a line of Times text to its baseline, per point of font size
const ASCENT = 0.891;

const GRADING_SCALE = [
  ["80-100", "A+", "4.00", "Outstanding"],
  ["75-79", "A", "3.75", "Excellent"],
  ["70-74", "A-", "3.50", "Very Good"],
  ["65-69", "B+", "3.25", "Good"],
  ["60-64", "B", "3.00", "Satisfactory"],
  ["55-59", "B-", "2.75", "Above Average"],
  ["50-54", "C+", "2.50", "Average"],
  ["45-49", "C", "2.25", "Below Average"],
  ["40-44", "D", "2.00", "Pass"],
  ["00-39", "F", "0.00", "Fail"],
];

// Degree names for the departments whose program we know; anything else shows the department code
const PROGRAMS: Record<string, string> = {
  CSE: "B.Sc. in CSE",
  SWE: "B.Sc. in SWE",
  EEE: "B.Sc. in EEE",
  CIS: "B.Sc. in CIS",
  ITM: "B.Sc. in ITM",
};

// Total credits of the degree, where known
const CREDIT_REQUIREMENTS: Record<string, number> = {
  CSE: 154.5,
};

const NOT_COUNTED = new Set(["I", "W", "R"]);

function formatCredits(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function isPassed(course: TranscriptCourse): boolean {
  const grade = (course.grade || "").trim().toUpperCase();
  return !NOT_COUNTED.has(grade) && grade !== "F" && course.grade_point > 0;
}

function courseKey(course: TranscriptCourse): string {
  const code = (course.code || "").replace(/[\s-]/g, "").toUpperCase();
  return code || (course.name || "").trim().toLowerCase();
}

// Same rule as the backend: F counts as 0 points, I/W/R and unpublished grades are left out
function semesterGpa(courses: TranscriptCourse[]): number {
  let points = 0;
  let credits = 0;
  for (const course of courses) {
    const grade = (course.grade || "").trim().toUpperCase();
    if (!NOT_COUNTED.has(grade) && grade !== "F" && course.grade_point > 0) {
      points += course.credits * course.grade_point;
      credits += course.credits;
    } else if (grade === "F") {
      credits += course.credits;
    }
  }
  return credits > 0 ? points / credits : 0;
}

// A retaken course is listed once: only its best attempt stays (highest grade point, the later one
// on a tie, as in the CGPA), in the semester it was earned. An I/W/R attempt only stays if the course
// has no graded attempt. Semesters that lost a course get their GPA recalculated from what they list.
function keepBestAttempts(semesters: TranscriptSemester[]): TranscriptSemester[] {
  const best = new Map<string, { semester: number; index: number; point: number; graded: boolean }>();
  semesters.forEach((semester, s) =>
    (semester.courses || []).forEach((course, index) => {
      const key = courseKey(course);
      if (!key) return;
      const graded = !NOT_COUNTED.has((course.grade || "").trim().toUpperCase());
      const seen = best.get(key);
      // Attempts are visited oldest first, so ">=" lets the later attempt win a tie
      const better = !seen || (graded ? !seen.graded || course.grade_point >= seen.point : !seen.graded);
      if (better) best.set(key, { semester: s, index, point: course.grade_point, graded });
    })
  );

  return semesters.map((semester, s) => {
    const courses = (semester.courses || []).filter((course, index) => {
      const kept = best.get(courseKey(course));
      return !kept || (kept.semester === s && kept.index === index);
    });
    if (courses.length === (semester.courses || []).length) return semester;
    return { ...semester, courses, gpa: semesterGpa(courses) };
  });
}

// Major = a course of the student's own department (course code starts with the department code,
// e.g. CSE113 for a CSE student); everything else is non-major. Retakes count once, best attempt,
// the same way the backend computes the overall CGPA.
function categoryCgpa(data: TranscriptData): { major: number | null; nonMajor: number | null } {
  const department = (data.student.department || "").toUpperCase();
  const best = new Map<string, { course: TranscriptCourse; order: number }>();
  let order = 0;
  for (const semester of data.semesters) {
    for (const course of semester.courses || []) {
      order++;
      const grade = (course.grade || "").trim().toUpperCase();
      const key = courseKey(course);
      if (!key || NOT_COUNTED.has(grade) || !(course.credits > 0)) continue;
      const seen = best.get(key);
      if (!seen || course.grade_point >= seen.course.grade_point) best.set(key, { course, order });
    }
  }

  const totals = { major: { points: 0, credits: 0 }, nonMajor: { points: 0, credits: 0 } };
  best.forEach(({ course }) => {
    // An F counts as 0 points; any other zero (e.g. a grade not published yet) is left out
    if (course.grade_point <= 0 && (course.grade || "").trim().toUpperCase() !== "F") return;
    const code = (course.code || "").replace(/\s/g, "").toUpperCase();
    const bucket = department && code.startsWith(department) ? totals.major : totals.nonMajor;
    bucket.points += course.credits * course.grade_point;
    bucket.credits += course.credits;
  });
  const cgpa = (t: { points: number; credits: number }) => (t.credits > 0 ? t.points / t.credits : null);
  return { major: cgpa(totals.major), nonMajor: cgpa(totals.nonMajor) };
}

function issueDate(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`;
}

// Same style as a browser's print header, e.g. "9/26/26, 9:42 PM"
function printedAt(now: Date): string {
  const hours = now.getHours() % 12 || 12;
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const period = now.getHours() < 12 ? "AM" : "PM";
  return `${now.getMonth() + 1}/${now.getDate()}/${String(now.getFullYear()).slice(-2)}, ${hours}:${minutes} ${period}`;
}

// Writes text whose top edge sits at `top` (the reference layout is measured by text tops)
function textAt(doc: jsPDF, text: string, x: number, top: number, size: number, options?: { align?: "center" | "right" }) {
  doc.setFontSize(size);
  doc.text(text, x, top + size * ASCENT, options);
}

export async function downloadTranscript(data: TranscriptData): Promise<void> {
  const doc = await buildTranscript(data);
  const safeId = (data.student.id || "student").replace(/[^0-9A-Za-z-]/g, "");
  doc.save(`Transcript_${safeId}.pdf`);
}

export async function buildTranscript(data: TranscriptData): Promise<jsPDF> {
  const [{ jsPDF }, { autoTable }] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);

  const doc = new jsPDF({ unit: "pt", format: "a4" });
  doc.setLineHeightFactor(LINE_HEIGHT_FACTOR);
  doc.setTextColor(BLACK);
  doc.setDrawColor(BLACK);

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const contentWidth = pageWidth - 2 * MARGIN;
  const center = pageWidth / 2;
  const bottomLimit = pageHeight - MARGIN;
  const now = new Date();
  const department = (data.student.department || "").toUpperCase();

  // University header
  doc.setFont("times", "bold");
  textAt(doc, "Daffodil International University", center, 32, 18, { align: "center" });
  doc.setFont("times", "normal");
  textAt(doc, "Daffodil Smart City, Birulia, Savar, Dhaka-1216 Bangladesh", center, 58.6, 8.25, { align: "center" });
  textAt(doc, "Tel: +88 02 9143254-5, 48111639, 48111670", center, 71.4, 8.25, { align: "center" });
  textAt(doc, "E-mail: info@daffodilvarsity.edu.bd", center, 83.4, 8.25, { align: "center" });

  doc.setFont("times", "bold");
  textAt(doc, "Transcript", center, 108, 13.5, { align: "center" });
  const titleWidth = doc.getTextWidth("Transcript");
  doc.setLineWidth(0.7);
  doc.line(center - titleWidth / 2, 121.2, center + titleWidth / 2, 121.2);

  // Student details (left)
  const summaryX = MARGIN + contentWidth * 0.6;
  const valueX = MARGIN + 105;
  const valueMaxWidth = summaryX - valueX - 10;
  const details: [string, string][] = [
    ["Program", data.student.program || PROGRAMS[department] || department || "-"],
    // The first semester with results (an ID's intake code can't tell a Spring/Fall-only department's
    // second intake from Summer, so it isn't used)
    ["Enrollment Session", data.semesters.find((s) => s.courses?.length)?.name || "-"],
    ["Date of Issue", issueDate(now)],
    ["Name of the Student", data.student.name || "-"],
    ["Student ID", data.student.id || "-"],
    ["Batch", data.student.batch || "-"],
  ];
  details.forEach(([label, value], i) => {
    const top = 145 + i * 18;
    doc.setFont("times", "bold");
    textAt(doc, label, MARGIN, top, 9);
    doc.setFont("times", "normal");
    // Shrink an unusually long value (e.g. a long name) so it never runs into the summary table
    let size = 9;
    doc.setFontSize(size);
    while (size > 6.5 && doc.getTextWidth(`: ${value}`) > valueMaxWidth) doc.setFontSize((size -= 0.25));
    textAt(doc, `: ${value}`, valueX, top, size);
  });

  // Academic summary (right)
  const { major, nonMajor } = categoryCgpa(data);
  const summary: [string, string][] = [["Overall CGPA", data.overall_cgpa.toFixed(2)]];
  if (major !== null && nonMajor !== null) {
    summary.push(["Major CGPA", major.toFixed(2)], ["Non-Major CGPA", nonMajor.toFixed(2)]);
  }
  summary.push(["Credits Completed", formatCredits(data.total_completed_credits)]);
  if (CREDIT_REQUIREMENTS[department]) {
    summary.push(["Total Credit Requirement", formatCredits(CREDIT_REQUIREMENTS[department])]);
  }

  doc.setFont("times", "bold");
  textAt(doc, "Academic Summary", summaryX, 142.7, 9);
  const summaryWidth = pageWidth - MARGIN - summaryX;
  autoTable(doc, {
    startY: 158.2,
    margin: { left: summaryX, right: MARGIN },
    tableWidth: summaryWidth,
    body: summary,
    theme: "grid",
    styles: {
      font: "times",
      fontSize: 9,
      textColor: BLACK,
      lineColor: BLACK,
      lineWidth: BORDER,
      cellPadding: { top: 4.33, bottom: 4.33, left: 4.3, right: 4.3 },
      valign: "middle",
    },
    columnStyles: {
      0: { cellWidth: summaryWidth - 48 },
      1: { cellWidth: 48, fontStyle: "bold" },
    },
  });

  // UGC grading system (left) and where to verify (right)
  const gradingWidth = contentWidth * 0.6;
  const gradingColumns = [96, 62.3, 55.4, 119.3].map((w) => (w / 333) * gradingWidth);
  autoTable(doc, {
    startY: 282.8,
    margin: { left: MARGIN, right: pageWidth - MARGIN - gradingWidth },
    tableWidth: gradingWidth,
    head: [
      [{ content: "UGC Uniform Grading System", colSpan: 4, styles: { fillColor: HEADER_FILL } }],
      ["Marks (%)", "Grade", "Point", "Remarks"],
    ],
    body: GRADING_SCALE,
    theme: "grid",
    styles: {
      font: "times",
      fontSize: 7.5,
      textColor: BLACK,
      lineColor: BLACK,
      lineWidth: BORDER,
      cellPadding: { top: 2.8, bottom: 2.8, left: 3, right: 3 },
      halign: "center",
      valign: "middle",
    },
    headStyles: { fillColor: false, fontStyle: "bold", textColor: BLACK },
    columnStyles: Object.fromEntries(gradingColumns.map((w, i) => [i, { cellWidth: w }])),
  });
  const gradingBottom = (doc as any).lastAutoTable.finalY as number;

  const verifyX = MARGIN + contentWidth * 0.677;
  doc.setFont("times", "bold");
  textAt(doc, "Verify Result", verifyX, 306.8, 7.5);
  doc.setFont("times", "normal");
  textAt(doc, "Visit the student portal to verify results:", verifyX, 318.1, 7.5);
  doc.setFont("times", "italic");
  textAt(doc, "https://studentportal.diu.edu.bd", verifyX, 329.3, 7.5);

  // One block per semester; a block is never split across pages
  const courseColumns = [72.7, 271.5, 55.5, 72, 84].map((w) => (w / 555.7) * contentWidth);
  const titleTextWidth = courseColumns[1] - 9;
  let top = gradingBottom + 24.8;

  for (const semester of keepBestAttempts(data.semesters)) {
    const courses = semester.courses || [];
    if (courses.length === 0) continue;

    doc.setFont("times", "normal");
    doc.setFontSize(8.25);
    const tableHeight =
      21 + courses.reduce((h, c) => h + 9 + 12 * doc.splitTextToSize(c.name || "", titleTextWidth).length, 0);
    const blockHeight = 26.9 + tableHeight;
    if (top + blockHeight > bottomLimit && blockHeight <= bottomLimit - MARGIN) {
      doc.addPage();
      top = MARGIN + 1;
    }

    const taken = courses.reduce((sum, c) => sum + (c.credits || 0), 0);
    const completed = courses.filter(isPassed).reduce((sum, c) => sum + (c.credits || 0), 0);
    doc.setFont("times", "bold");
    textAt(doc, `Semester: ${semester.name}`, MARGIN, top, 8.25);
    const totals = [
      `Credit Taken: ${formatCredits(taken)}`,
      `Credit Completed: ${formatCredits(completed)}`,
      `GPA: ${(semester.gpa || 0).toFixed(2)}`,
    ];
    textAt(doc, totals.join("     "), MARGIN, top + 12, 8.25);

    autoTable(doc, {
      startY: top + 26.9,
      margin: { left: MARGIN, right: MARGIN, top: MARGIN, bottom: MARGIN },
      tableWidth: contentWidth,
      head: [["Course Code", "Course Title", "Credit", "Grade", "Grade Point"]],
      body: courses.map((c) => [
        c.code || "",
        c.name || "",
        formatCredits(c.credits || 0),
        c.grade || "N/A",
        (c.grade_point || 0).toFixed(2),
      ]),
      theme: "grid",
      rowPageBreak: "avoid",
      styles: {
        font: "times",
        fontSize: 8.25,
        textColor: BLACK,
        lineColor: BLACK,
        lineWidth: BORDER,
        cellPadding: { top: 4.5, bottom: 4.5, left: 4.5, right: 4.5 },
        valign: "middle",
      },
      headStyles: { fillColor: HEADER_FILL, fontStyle: "bold", textColor: BLACK },
      columnStyles: {
        0: { cellWidth: courseColumns[0] },
        1: { cellWidth: courseColumns[1] },
        2: { cellWidth: courseColumns[2], halign: "center" },
        3: { cellWidth: courseColumns[3], halign: "center" },
        4: { cellWidth: courseColumns[4], halign: "center" },
      },
      didParseCell: (hook) => {
        if (hook.section === "head" && hook.column.index >= 2) hook.cell.styles.halign = "center";
      },
    });
    top = (doc as any).lastAutoTable.finalY + 16.6;
  }

  // Print date (top left) and page number (bottom right) on every page
  const pages = doc.getNumberOfPages();
  doc.setFont("helvetica", "normal");
  for (let page = 1; page <= pages; page++) {
    doc.setPage(page);
    textAt(doc, printedAt(now), 24, 14.7, 8);
    textAt(doc, `${page}/${pages}`, pageWidth - 24, pageHeight - 25.8, 8, { align: "right" });
  }

  return doc;
}
