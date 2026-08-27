// Streams rows to disk (no in-memory StringBuilder — a vscode-scale dump with parameter rows
// exceeds the JVM's 2GB array cap otherwise).
@main def main(cpgFile: String, outFile: String) = {
  importCpg(cpgFile)
  val pw = new java.io.PrintWriter(new java.io.BufferedWriter(new java.io.FileWriter(outFile), 1 << 20))
  cpg.call.foreach { c =>
    if (!c.name.startsWith("<operator")) {
      val caller = c.method.fullName
      val direct = c.methodFullName
      val linked = c.callee.fullName.l.mkString("|")
      pw.println(s"C\t${caller}\t${c.name}\t${direct}\t${linked}\t${c.lineNumber.getOrElse(-1)}")
    }
  }
  cpg.method.foreach { m =>
    pw.println(s"M\t${m.fullName}\t${m.lineNumber.getOrElse(-1)}\t${m.columnNumber.getOrElse(-1)}")
    m.parameter.foreach { p => pw.println(s"P\t${m.fullName}\t${p.name}") }
  }
  pw.close()
}
