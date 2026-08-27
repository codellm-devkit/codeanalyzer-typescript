@main def main(cpgFile: String, outFile: String) = {
  importCpg(cpgFile)
  val sb = new StringBuilder
  cpg.call.foreach { c =>
    if (!c.name.startsWith("<operator")) {
      val caller = c.method.fullName
      val direct = c.methodFullName
      val linked = c.callee.fullName.l.mkString("|")
      sb.append(s"C\t${caller}\t${c.name}\t${direct}\t${linked}\t${c.lineNumber.getOrElse(-1)}\n")
    }
  }
  cpg.method.foreach { m =>
    sb.append(s"M\t${m.fullName}\t${m.lineNumber.getOrElse(-1)}\t${m.columnNumber.getOrElse(-1)}\n")
  }
  val pw = new java.io.PrintWriter(outFile); pw.write(sb.toString); pw.close()
}
